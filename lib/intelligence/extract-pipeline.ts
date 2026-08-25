import { eq } from "drizzle-orm";
import {
  type ExtractionAnalysisContext,
  runSourceExtraction,
} from "@/lib/ai/capabilities/source-extraction";
import {
  canonicalJson,
  hashContextPack,
  type SourceContextPack,
} from "@/lib/ai/context";
import {
  brand,
  campaign,
  client,
  contextSnapshot,
  organization,
  project,
  source,
  sourceAnalysis,
  sourceChapter,
  sourceExtraction,
  sourceExtractionRun,
} from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { recordUsage } from "@/lib/ledger";
import { sanitizeIngestError } from "@/lib/media/ingest-error";
import { loadCurrentTranscript } from "@/lib/transcription/store";
import { type GroundedExtraction, groundExtractions } from "./grounding";

// The S5 extraction workflow: claim → assemble context (summary/chapters
// when analysis is ready) → run the four passes → ground every item against
// the word timeline → persist rows + metering. Mirrors
// lib/analysis/pipeline.ts: same claim contract, same failure recording,
// runs under Trigger or the in-process dev fallback.
//
// Grounding is the gate (AGENTS §Source intelligence): rows that fail
// alignment are stored with grounded=false for run stats but never surface
// by default, and ranges of grounded rows are SNAPPED to word boundaries —
// which is what makes every surfaced range playable and exact.

const EXTRACT_ERROR_MAX_CHARS = 2000;

export interface ExtractionPayload {
  organizationId: string;
  sourceId: string;
}

interface ClaimedRun {
  attempt: number;
  runId: string;
}

async function claimRun(
  payload: ExtractionPayload
): Promise<ClaimedRun | null> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [existing] = await tx
      .select({
        attempts: sourceExtractionRun.attempts,
        id: sourceExtractionRun.id,
        status: sourceExtractionRun.status,
      })
      .from(sourceExtractionRun)
      .where(eq(sourceExtractionRun.sourceId, payload.sourceId))
      .limit(1);

    if (!existing) {
      const [created] = await tx
        .insert(sourceExtractionRun)
        .values({
          attempts: 1,
          organizationId: payload.organizationId,
          sourceId: payload.sourceId,
          status: "processing",
        })
        .onConflictDoNothing({ target: sourceExtractionRun.sourceId })
        .returning({ id: sourceExtractionRun.id });
      return created ? { attempt: 1, runId: created.id } : null;
    }
    if (existing.status === "processing" || existing.status === "ready") {
      return null;
    }
    await tx
      .update(sourceExtractionRun)
      .set({
        attempts: existing.attempts + 1,
        error: null,
        status: "processing",
      })
      .where(eq(sourceExtractionRun.id, existing.id));
    return { attempt: existing.attempts + 1, runId: existing.id };
  });
}

// finalAttempt=false (a Trigger retry is coming) parks the row back in
// "pending" — the queue state the next attempt's claim picks up and the UI
// renders as still-working, with the poller alive — instead of flashing a
// terminal "failed" for a run that recovers seconds later. The error text
// is kept as a breadcrumb; the next claim clears it.
async function recordRunFailure(
  payload: ExtractionPayload,
  runId: string,
  error: unknown,
  finalAttempt: boolean
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown extraction failure";
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(sourceExtractionRun)
      .set({
        error: sanitizeIngestError(message).slice(0, EXTRACT_ERROR_MAX_CHARS),
        status: finalAttempt ? "failed" : "pending",
      })
      .where(eq(sourceExtractionRun.id, runId))
  );
}

interface ExtractionContext {
  analysis: ExtractionAnalysisContext | null;
  durationSeconds: number;
  pack: SourceContextPack;
}

async function assembleContext(
  payload: ExtractionPayload,
  language: string | null,
  speakerCount: number
): Promise<ExtractionContext> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [row] = await tx
      .select({
        brandName: brand.name,
        clientName: client.name,
        durationSeconds: source.durationSeconds,
        organizationName: organization.name,
        originalFilename: source.originalFilename,
        projectName: project.name,
        title: source.title,
      })
      .from(source)
      .innerJoin(project, eq(source.projectId, project.id))
      .innerJoin(campaign, eq(project.campaignId, campaign.id))
      .innerJoin(brand, eq(campaign.brandId, brand.id))
      .innerJoin(client, eq(brand.clientId, client.id))
      .innerJoin(organization, eq(source.organizationId, organization.id))
      .where(eq(source.id, payload.sourceId))
      .limit(1);
    if (!row?.durationSeconds) {
      throw new Error("Source is not ready for extraction");
    }

    // Analysis output enriches the prefix when present; extraction still
    // runs without it (the job is chained after analysis, but a failed
    // analysis must not block extraction forever).
    const [analysisRow] = await tx
      .select({
        id: sourceAnalysis.id,
        status: sourceAnalysis.status,
        summary: sourceAnalysis.summary,
      })
      .from(sourceAnalysis)
      .where(eq(sourceAnalysis.sourceId, payload.sourceId))
      .limit(1);
    let analysis: ExtractionAnalysisContext | null = null;
    if (analysisRow?.status === "ready") {
      const chapters = await tx
        .select({ startMs: sourceChapter.startMs, title: sourceChapter.title })
        .from(sourceChapter)
        .where(eq(sourceChapter.analysisId, analysisRow.id))
        .orderBy(sourceChapter.idx);
      analysis = { chapters, summary: analysisRow.summary };
    }

    const pack: SourceContextPack = {
      brand: row.brandName ? { name: row.brandName } : null,
      client: row.clientName ? { name: row.clientName } : null,
      kind: "source-extraction",
      organization: { name: row.organizationName },
      project: row.projectName ? { name: row.projectName } : null,
      source: {
        durationSeconds: row.durationSeconds,
        language,
        originalFilename: row.originalFilename,
        speakerCount,
        title: row.title,
      },
      version: 1,
    };
    return { analysis, durationSeconds: row.durationSeconds, pack };
  });
}

function countByKind(
  rows: readonly GroundedExtraction[]
): Record<string, { grounded: number; total: number }> {
  const counts: Record<string, { grounded: number; total: number }> = {};
  for (const row of rows) {
    const entry = counts[row.kind] ?? { grounded: 0, total: 0 };
    entry.total += 1;
    if (row.grounded) {
      entry.grounded += 1;
    }
    counts[row.kind] = entry;
  }
  return counts;
}

export interface RunAttemptOptions {
  // False when the caller (a Trigger task) knows another retry attempt is
  // scheduled after a failure. The in-process dev fallback has no retries,
  // so the default is final.
  finalAttempt?: boolean;
}

export async function runExtraction(
  payload: ExtractionPayload,
  options: RunAttemptOptions = {}
): Promise<void> {
  const claimed = await claimRun(payload);
  if (!claimed) {
    return;
  }

  try {
    const transcript = await loadCurrentTranscript(
      payload.organizationId,
      payload.sourceId
    );
    if (!transcript) {
      throw new Error("Source has no ready transcript to extract from");
    }
    const speakerCount = new Set(
      transcript.data.words.map((word) => word.speaker).filter(Boolean)
    ).size;
    const context = await assembleContext(
      payload,
      transcript.data.language,
      speakerCount
    );
    const durationMs = Math.round(context.durationSeconds * 1000);

    const result = await runSourceExtraction({
      analysis: context.analysis,
      contextPack: context.pack,
      durationMs,
      transcript: transcript.data,
    });
    const rows = groundExtractions(
      result.items,
      transcript.data.words,
      durationMs
    );

    await withOrgScope(payload.organizationId, async (tx) => {
      const [snapshot] = await tx
        .insert(contextSnapshot)
        .values({
          content: JSON.parse(canonicalJson(context.pack)),
          hash: hashContextPack(context.pack),
          kind: context.pack.kind,
          organizationId: payload.organizationId,
        })
        .returning({ id: contextSnapshot.id });

      // Re-runs replace: extractions belong to exactly one run per source.
      await tx
        .delete(sourceExtraction)
        .where(eq(sourceExtraction.sourceId, payload.sourceId));
      if (rows.length > 0) {
        await tx.insert(sourceExtraction).values(
          rows.map((row) => ({
            ...row,
            organizationId: payload.organizationId,
            revision: transcript.revision,
            runId: claimed.runId,
            sourceId: payload.sourceId,
          }))
        );
      }

      await tx
        .update(sourceExtractionRun)
        .set({
          contextSnapshotId: snapshot?.id ?? null,
          counts: countByKind(rows),
          error: null,
          models: Object.fromEntries(
            result.usage.map((usage) => [
              usage.task,
              { model: usage.model, provider: usage.provider },
            ])
          ),
          revision: transcript.revision,
          status: "ready",
        })
        .where(eq(sourceExtractionRun.id, claimed.runId));

      // Metering (cross-cutting rule 1): one ai_tokens entry per pass.
      for (const usage of result.usage) {
        // biome-ignore lint/performance/noAwaitInLoops: at most four entries, same tx
        await recordUsage(tx, {
          correlationId: `extract:${payload.sourceId}:${claimed.attempt}:${usage.task}`,
          entryType: "ai_tokens",
          metadata: {
            costUsd: usage.costUsd,
            inputTokens: usage.inputTokens,
            model: usage.model,
            outputTokens: usage.outputTokens,
            provider: usage.provider,
            sourceHours: context.durationSeconds / 3600,
            task: usage.task,
          },
          organizationId: payload.organizationId,
          quantity: usage.inputTokens + usage.outputTokens,
          sourceId: payload.sourceId,
          unit: "tokens",
        });
      }
    });

    // Moment discovery is the next follow-on job (the analysis→extraction
    // pattern, one level down): enqueued once the extractions are committed
    // so the discovery pass can cite them as seeds, errors contained — a
    // failed enqueue must not fail a finished extraction.
    try {
      const { enqueueDiscovery } = await import("./discover-enqueue");
      await enqueueDiscovery(payload);
    } catch (error) {
      console.error(
        `[extract] discovery enqueue failed for ${payload.sourceId}:`,
        error
      );
    }
  } catch (error) {
    await recordRunFailure(
      payload,
      claimed.runId,
      error,
      options.finalAttempt ?? true
    );
    throw error;
  }
}
