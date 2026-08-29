import { and, eq, sql } from "drizzle-orm";
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
  captureStructuredUsage,
  type StructuredUsage,
  structuredFailureUsages,
} from "@/lib/ai/generate";
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
import { type OrgTransaction, withOrgScope } from "@/lib/db/tenant";
import { startLeaseHeartbeat } from "@/lib/lease-heartbeat";
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
const EXTRACTION_HEARTBEAT_INTERVAL_MS = 60_000;

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

    if (existing?.status !== "pending") {
      return null;
    }
    const [claimed] = await tx
      .update(sourceExtractionRun)
      .set({
        attempts: existing.attempts + 1,
        error: null,
        status: "processing",
      })
      .where(
        and(
          eq(sourceExtractionRun.id, existing.id),
          eq(sourceExtractionRun.attempts, existing.attempts),
          eq(sourceExtractionRun.status, existing.status)
        )
      )
      .returning({ id: sourceExtractionRun.id });
    return claimed
      ? { attempt: existing.attempts + 1, runId: existing.id }
      : null;
  });
}

// finalAttempt=false (a Trigger retry is coming) parks the row back in
// "pending" — the queue state the next attempt's claim picks up and the UI
// renders as still-working, with the poller alive — instead of flashing a
// terminal "failed" for a run that recovers seconds later. The error text
// is kept as a breadcrumb; the next claim clears it.
async function recordRunFailure(
  payload: ExtractionPayload,
  claimed: ClaimedRun,
  error: unknown,
  finalAttempt: boolean,
  capturedUsage: readonly StructuredUsage[]
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown extraction failure";
  await withOrgScope(payload.organizationId, async (tx) => {
    await tx
      .update(sourceExtractionRun)
      .set({
        error: sanitizeIngestError(message).slice(0, EXTRACT_ERROR_MAX_CHARS),
        status: finalAttempt ? "failed" : "pending",
      })
      .where(
        and(
          eq(sourceExtractionRun.id, claimed.runId),
          eq(sourceExtractionRun.attempts, claimed.attempt),
          eq(sourceExtractionRun.status, "processing")
        )
      );
    // Model spend remains real even when this worker lost the lifecycle CAS.
    // Group it per task and use the attempt-scoped correlation key so a
    // retried failure recorder stays idempotent.
    for (const failedUsage of structuredFailureUsages(error, capturedUsage)) {
      // biome-ignore lint/performance/noAwaitInLoops: few task-level entries, same tx
      await recordUsage(tx, {
        correlationId: `extract:${payload.sourceId}:${claimed.attempt}:failed:${failedUsage.task}`,
        entryType: "ai_tokens",
        metadata: {
          attemptedModels: failedUsage.attemptedModels,
          attempts: failedUsage.attempts,
          cacheReadTokens: failedUsage.cacheReadTokens,
          cacheWriteTokens: failedUsage.cacheWriteTokens,
          costUsd: failedUsage.costUsd,
          failed: true,
          inputTokens: failedUsage.inputTokens,
          model: failedUsage.model,
          outputTokens: failedUsage.outputTokens,
          provider: failedUsage.provider,
          task: failedUsage.task,
          upstreamProvider: failedUsage.upstreamProvider,
        },
        organizationId: payload.organizationId,
        quantity: failedUsage.inputTokens + failedUsage.outputTokens,
        sourceId: payload.sourceId,
        unit: "tokens",
      });
    }
  });
}

async function heartbeatExtraction(
  payload: ExtractionPayload,
  claimed: ClaimedRun
): Promise<boolean> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [touched] = await tx
      .update(sourceExtractionRun)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(sourceExtractionRun.id, claimed.runId),
          eq(sourceExtractionRun.attempts, claimed.attempt),
          eq(sourceExtractionRun.status, "processing")
        )
      )
      .returning({ id: sourceExtractionRun.id });
    return Boolean(touched);
  });
}

function startExtractionHeartbeat(
  payload: ExtractionPayload,
  claimed: ClaimedRun
): () => Promise<void> {
  return startLeaseHeartbeat({
    heartbeat: () => heartbeatExtraction(payload, claimed),
    intervalMs: EXTRACTION_HEARTBEAT_INTERVAL_MS,
    onError: (error) => {
      console.error(
        `[extract] heartbeat failed for run ${claimed.runId}:`,
        error
      );
    },
  });
}

async function assertActiveAttempt(
  tx: OrgTransaction,
  claimed: ClaimedRun
): Promise<void> {
  await tx.execute(
    sql`SELECT ${sourceExtractionRun.id} FROM ${sourceExtractionRun} WHERE ${sourceExtractionRun.id} = ${claimed.runId} FOR UPDATE`
  );
  const [active] = await tx
    .select({ id: sourceExtractionRun.id })
    .from(sourceExtractionRun)
    .where(
      and(
        eq(sourceExtractionRun.id, claimed.runId),
        eq(sourceExtractionRun.attempts, claimed.attempt),
        eq(sourceExtractionRun.status, "processing")
      )
    )
    .limit(1);
  if (!active) {
    throw new Error("Source extraction attempt is no longer active");
  }
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
  const stopHeartbeat = startExtractionHeartbeat(payload, claimed);
  const capturedUsage: StructuredUsage[] = [];

  try {
    await captureStructuredUsage(capturedUsage, async () => {
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
        // A reaper may have retired this attempt while a provider call was in
        // flight. Lock and verify the exact claim before replacing extraction
        // rows or writing the snapshot and metering for it.
        await assertActiveAttempt(tx, claimed);
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

        const [finalized] = await tx
          .update(sourceExtractionRun)
          .set({
            contextSnapshotId: snapshot?.id ?? null,
            counts: countByKind(rows),
            error: null,
            models: Object.fromEntries(
              result.usage.map((usage) => [
                usage.task,
                {
                  attemptedModels: usage.attemptedModels,
                  attempts: usage.attempts,
                  cacheReadTokens: usage.cacheReadTokens,
                  cacheWriteTokens: usage.cacheWriteTokens,
                  model: usage.model,
                  provider: usage.provider,
                  upstreamProvider: usage.upstreamProvider,
                },
              ])
            ),
            revision: transcript.revision,
            status: "ready",
          })
          .where(
            and(
              eq(sourceExtractionRun.id, claimed.runId),
              eq(sourceExtractionRun.attempts, claimed.attempt),
              eq(sourceExtractionRun.status, "processing")
            )
          )
          .returning({ id: sourceExtractionRun.id });
        if (!finalized) {
          throw new Error(
            "Source extraction attempt lost its finalization lease"
          );
        }

        // Metering (cross-cutting rule 1): one ai_tokens entry per pass.
        for (const usage of result.usage) {
          // biome-ignore lint/performance/noAwaitInLoops: at most four entries, same tx
          await recordUsage(tx, {
            correlationId: `extract:${payload.sourceId}:${claimed.attempt}:${usage.task}`,
            entryType: "ai_tokens",
            metadata: {
              attemptedModels: usage.attemptedModels,
              attempts: usage.attempts,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              costUsd: usage.costUsd,
              inputTokens: usage.inputTokens,
              model: usage.model,
              outputTokens: usage.outputTokens,
              provider: usage.provider,
              sourceHours: context.durationSeconds / 3600,
              task: usage.task,
              upstreamProvider: usage.upstreamProvider,
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
    });
  } catch (error) {
    await recordRunFailure(
      payload,
      claimed,
      error,
      options.finalAttempt ?? true,
      capturedUsage
    );
    throw error;
  } finally {
    await stopHeartbeat();
  }
}
