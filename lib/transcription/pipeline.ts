import { and, desc, eq } from "drizzle-orm";
import {
  source,
  sourceArtifact,
  transcript,
  transcriptRevision,
} from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { recordUsage } from "@/lib/ledger";
import { sanitizeIngestError } from "@/lib/media/ingest-error";
import { presignGetUrl, putJson } from "@/lib/storage";
import { sourcePrefixFromOriginalKey } from "@/lib/storage/keys";
import { getTranscriptionProvider } from "./provider";
import type { TranscriptData } from "./types";

// The S3 transcription workflow: claim → hand the audio artifact's presigned
// URL to the provider → sanity-check → store canonical JSON → revision row +
// metering. Runs the same whether invoked by the Trigger.dev task or the
// in-process dev fallback, mirroring lib/media/pipeline.ts. Every DB touch
// goes through withOrgScope.

const TRANSCRIPT_ERROR_MAX_CHARS = 2000;

// Words may legitimately end well before the media does (silence, credits);
// the S2 truncation failure mode does not apply in that direction. A word
// *past* the media's end means the provider transcribed the wrong or a
// corrupt object — that direction is enforced.
const DURATION_SLACK_MS = 2000;

export interface TranscriptionPayload {
  organizationId: string;
  sourceId: string;
}

interface ClaimedTranscript {
  attempt: number;
  transcriptId: string;
}

// Idempotent claim, same contract as claimSource: only pending/failed rows
// (or a missing row) are claimable; processing and ready no-op, so retried
// triggers and double-enqueues are harmless.
async function claimTranscript(
  payload: TranscriptionPayload
): Promise<ClaimedTranscript | null> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [existing] = await tx
      .select({
        attempts: transcript.attempts,
        id: transcript.id,
        status: transcript.status,
      })
      .from(transcript)
      .where(eq(transcript.sourceId, payload.sourceId))
      .limit(1);

    if (!existing) {
      const [created] = await tx
        .insert(transcript)
        .values({
          attempts: 1,
          organizationId: payload.organizationId,
          sourceId: payload.sourceId,
          status: "processing",
        })
        .onConflictDoNothing({ target: transcript.sourceId })
        .returning({ id: transcript.id });
      // Conflict means another claim won the race between select and insert.
      return created ? { attempt: 1, transcriptId: created.id } : null;
    }

    if (existing.status === "processing" || existing.status === "ready") {
      return null;
    }

    await tx
      .update(transcript)
      .set({
        attempts: existing.attempts + 1,
        error: null,
        status: "processing",
      })
      .where(eq(transcript.id, existing.id));
    return { attempt: existing.attempts + 1, transcriptId: existing.id };
  });
}

function assertWithinDuration(data: TranscriptData): void {
  const limitMs = data.durationMs + DURATION_SLACK_MS;
  const overrun = data.words.find((word) => word.endMs > limitMs);
  if (overrun) {
    throw new Error(
      `Transcript word at ${overrun.endMs}ms exceeds media duration ${data.durationMs}ms — wrong or corrupt audio object`
    );
  }
}

async function recordTranscriptFailure(
  payload: TranscriptionPayload,
  transcriptId: string,
  error: unknown
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown transcription failure";
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(transcript)
      .set({
        error: sanitizeIngestError(message).slice(
          0,
          TRANSCRIPT_ERROR_MAX_CHARS
        ),
        status: "failed",
      })
      .where(eq(transcript.id, transcriptId))
  );
}

export async function runTranscription(
  payload: TranscriptionPayload
): Promise<void> {
  const claimed = await claimTranscript(payload);
  if (!claimed) {
    return;
  }

  try {
    const provider = getTranscriptionProvider();
    if (!provider) {
      throw new Error(
        "No transcription provider configured (set DEEPGRAM_API_KEY or TRANSCRIPTION_PROVIDER)"
      );
    }

    const context = await withOrgScope(payload.organizationId, async (tx) => {
      const [sourceRow] = await tx
        .select({
          durationSeconds: source.durationSeconds,
          status: source.status,
          storageKey: source.storageKey,
        })
        .from(source)
        .where(eq(source.id, payload.sourceId))
        .limit(1);

      const [audioRow] = await tx
        .select({
          mimeType: sourceArtifact.mimeType,
          storageKey: sourceArtifact.storageKey,
        })
        .from(sourceArtifact)
        .where(
          and(
            eq(sourceArtifact.sourceId, payload.sourceId),
            eq(sourceArtifact.kind, "audio")
          )
        )
        .limit(1);

      const [latestRevision] = await tx
        .select({ revision: transcriptRevision.revision })
        .from(transcriptRevision)
        .where(eq(transcriptRevision.transcriptId, claimed.transcriptId))
        .orderBy(desc(transcriptRevision.revision))
        .limit(1);

      return { audioRow, latestRevision, sourceRow };
    });

    if (context.sourceRow?.status !== "ready") {
      throw new Error("Source is not ready for transcription");
    }
    if (!context.audioRow) {
      throw new Error("Source has no audio artifact to transcribe");
    }
    const { durationSeconds, storageKey: originalKey } = context.sourceRow;
    if (!durationSeconds) {
      throw new Error("Source has no duration — probe metadata missing");
    }

    const audioUrl = await presignGetUrl(context.audioRow.storageKey);
    const result = await provider.transcribe({
      audioUrl,
      durationSeconds,
      mimeType: context.audioRow.mimeType,
    });
    assertWithinDuration(result.data);

    const revision = (context.latestRevision?.revision ?? 0) + 1;
    const keyPrefix = sourcePrefixFromOriginalKey(originalKey);
    const storageKey = `${keyPrefix}transcript/rev-${revision}.json`;
    const body = JSON.stringify(result.data);
    const sizeBytes = Buffer.byteLength(body);
    await putJson(storageKey, result.data);

    await withOrgScope(payload.organizationId, async (tx) => {
      await tx.insert(transcriptRevision).values({
        // Machine revision: created_by stays null; human corrections set it
        metadata: {
          durationMs: result.data.durationMs,
          wordCount: result.data.words.length,
        },
        organizationId: payload.organizationId,
        revision,
        sizeBytes,
        storageKey,
        transcriptId: claimed.transcriptId,
      });

      await tx
        .update(transcript)
        .set({
          error: null,
          language: result.data.language,
          model: result.model,
          provider: result.provider,
          status: "ready",
        })
        .where(eq(transcript.id, claimed.transcriptId));

      // Metered like processing_minutes: media minutes are the cost driver.
      await recordUsage(tx, {
        correlationId: `transcription:${payload.sourceId}:${claimed.attempt}`,
        entryType: "transcription_minutes",
        metadata: { model: result.model, provider: result.provider },
        organizationId: payload.organizationId,
        quantity: durationSeconds / 60,
        sourceId: payload.sourceId,
        unit: "minutes",
      });

      // Each revision is a new object, never an overwrite, so its full size
      // is net-new — no delta arithmetic like the artifacts entry needs.
      await recordUsage(tx, {
        correlationId: `storage:transcript:${claimed.transcriptId}:${revision}`,
        entryType: "storage_bytes",
        metadata: { category: "transcript", revision },
        organizationId: payload.organizationId,
        quantity: sizeBytes,
        sourceId: payload.sourceId,
        unit: "bytes",
      });
    });

    // Idempotency guard for retries that lost a race after putJson: the
    // unique (transcript_id, revision) index makes the insert the arbiter —
    // a duplicate throws, recordTranscriptFailure marks it, and the claim
    // gate prevents concurrent runs in the first place.
  } catch (error) {
    await recordTranscriptFailure(payload, claimed.transcriptId, error);
    throw error;
  }
}
