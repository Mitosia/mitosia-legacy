import { and, eq, sql } from "drizzle-orm";
import {
  runSourceAnalysis,
  type SourceAnalysisResult,
} from "@/lib/ai/capabilities/source-analysis";
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
} from "@/lib/db/schema";
import { type OrgTransaction, withOrgScope } from "@/lib/db/tenant";
import { startLeaseHeartbeat } from "@/lib/lease-heartbeat";
import { recordUsage } from "@/lib/ledger";
import { sanitizeIngestError } from "@/lib/media/ingest-error";
import { loadCurrentTranscript } from "@/lib/transcription/store";

// The S4 analysis workflow: claim → assemble + snapshot the context pack →
// run the capability → persist chapters/editorial + metering. Mirrors
// lib/transcription/pipeline.ts exactly: same claim contract, same failure
// recording, runs under Trigger or the in-process dev fallback.

const ANALYSIS_ERROR_MAX_CHARS = 2000;
const ANALYSIS_HEARTBEAT_INTERVAL_MS = 60_000;

export interface AnalysisPayload {
  organizationId: string;
  sourceId: string;
}

interface ClaimedAnalysis {
  analysisId: string;
  attempt: number;
}

async function claimAnalysis(
  payload: AnalysisPayload
): Promise<ClaimedAnalysis | null> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [existing] = await tx
      .select({
        attempts: sourceAnalysis.attempts,
        id: sourceAnalysis.id,
        status: sourceAnalysis.status,
      })
      .from(sourceAnalysis)
      .where(eq(sourceAnalysis.sourceId, payload.sourceId))
      .limit(1);

    if (existing?.status !== "pending") {
      return null;
    }
    const [claimed] = await tx
      .update(sourceAnalysis)
      .set({
        attempts: existing.attempts + 1,
        error: null,
        status: "processing",
      })
      .where(
        and(
          eq(sourceAnalysis.id, existing.id),
          eq(sourceAnalysis.attempts, existing.attempts),
          eq(sourceAnalysis.status, existing.status)
        )
      )
      .returning({ id: sourceAnalysis.id });
    return claimed
      ? { analysisId: existing.id, attempt: existing.attempts + 1 }
      : null;
  });
}

// finalAttempt=false (a Trigger retry is coming) parks the row back in
// "pending" instead of flashing a terminal "failed" between attempts (see
// lib/intelligence/extract-pipeline.ts, same contract).
async function recordAnalysisFailure(
  payload: AnalysisPayload,
  claimed: ClaimedAnalysis,
  error: unknown,
  finalAttempt: boolean,
  capturedUsage: readonly StructuredUsage[]
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown analysis failure";
  await withOrgScope(payload.organizationId, async (tx) => {
    await tx
      .update(sourceAnalysis)
      .set({
        error: sanitizeIngestError(message).slice(0, ANALYSIS_ERROR_MAX_CHARS),
        status: finalAttempt ? "failed" : "pending",
      })
      .where(
        and(
          eq(sourceAnalysis.id, claimed.analysisId),
          eq(sourceAnalysis.attempts, claimed.attempt),
          eq(sourceAnalysis.status, "processing")
        )
      );
    // Model spend remains real even when this worker lost the lifecycle CAS.
    // Group it per task and use the attempt-scoped correlation key so a
    // retried failure recorder stays idempotent.
    for (const failedUsage of structuredFailureUsages(error, capturedUsage)) {
      // biome-ignore lint/performance/noAwaitInLoops: few task-level entries, same tx
      await recordUsage(tx, {
        correlationId: `analysis:${payload.sourceId}:${claimed.attempt}:failed:${failedUsage.task}`,
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

async function heartbeatAnalysis(
  payload: AnalysisPayload,
  claimed: ClaimedAnalysis
): Promise<boolean> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [touched] = await tx
      .update(sourceAnalysis)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(sourceAnalysis.id, claimed.analysisId),
          eq(sourceAnalysis.attempts, claimed.attempt),
          eq(sourceAnalysis.status, "processing")
        )
      )
      .returning({ id: sourceAnalysis.id });
    return Boolean(touched);
  });
}

function startAnalysisHeartbeat(
  payload: AnalysisPayload,
  claimed: ClaimedAnalysis
): () => Promise<void> {
  return startLeaseHeartbeat({
    heartbeat: () => heartbeatAnalysis(payload, claimed),
    intervalMs: ANALYSIS_HEARTBEAT_INTERVAL_MS,
    onError: (error) => {
      console.error(
        `[analysis] heartbeat failed for run ${claimed.analysisId}:`,
        error
      );
    },
  });
}

async function assertActiveAttempt(
  tx: OrgTransaction,
  claimed: ClaimedAnalysis
): Promise<void> {
  await tx.execute(
    sql`SELECT ${sourceAnalysis.id} FROM ${sourceAnalysis} WHERE ${sourceAnalysis.id} = ${claimed.analysisId} FOR UPDATE`
  );
  const [active] = await tx
    .select({ id: sourceAnalysis.id })
    .from(sourceAnalysis)
    .where(
      and(
        eq(sourceAnalysis.id, claimed.analysisId),
        eq(sourceAnalysis.attempts, claimed.attempt),
        eq(sourceAnalysis.status, "processing")
      )
    )
    .limit(1);
  if (!active) {
    throw new Error("Source analysis attempt is no longer active");
  }
}

interface SourceContext {
  durationSeconds: number;
  pack: SourceContextPack;
}

async function assembleContext(
  payload: AnalysisPayload,
  language: string | null,
  speakerCount: number
): Promise<SourceContext> {
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
      throw new Error("Source is not ready for analysis");
    }

    const pack: SourceContextPack = {
      brand: row.brandName ? { name: row.brandName } : null,
      client: row.clientName ? { name: row.clientName } : null,
      kind: "source-analysis",
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
    return { durationSeconds: row.durationSeconds, pack };
  });
}

async function persistAnalysis(
  payload: AnalysisPayload,
  claimed: ClaimedAnalysis,
  pack: SourceContextPack,
  durationSeconds: number,
  result: SourceAnalysisResult
): Promise<void> {
  await withOrgScope(payload.organizationId, async (tx) => {
    // A reaper may have retired this attempt while a provider call was in
    // flight. Lock and verify the exact claim before replacing chapters or
    // writing the snapshot and metering for it.
    await assertActiveAttempt(tx, claimed);
    const [snapshot] = await tx
      .insert(contextSnapshot)
      .values({
        content: JSON.parse(canonicalJson(pack)),
        hash: hashContextPack(pack),
        kind: pack.kind,
        organizationId: payload.organizationId,
      })
      .returning({ id: contextSnapshot.id });

    // Re-runs replace: chapters belong to the analysis, and the analysis
    // is one-per-source.
    await tx
      .delete(sourceChapter)
      .where(eq(sourceChapter.analysisId, claimed.analysisId));
    if (result.chapters.length > 0) {
      await tx.insert(sourceChapter).values(
        result.chapters.map((chapter, idx) => ({
          analysisId: claimed.analysisId,
          endMs: chapter.endMs,
          idx,
          organizationId: payload.organizationId,
          startMs: chapter.startMs,
          summary: chapter.summary,
          title: chapter.title,
        }))
      );
    }

    const [finalized] = await tx
      .update(sourceAnalysis)
      .set({
        contextSnapshotId: snapshot?.id ?? null,
        entities: result.editorial.entities,
        error: null,
        models: Object.fromEntries(
          result.usage.map((u) => [
            u.task,
            {
              attemptedModels: u.attemptedModels,
              attempts: u.attempts,
              cacheReadTokens: u.cacheReadTokens,
              cacheWriteTokens: u.cacheWriteTokens,
              model: u.model,
              provider: u.provider,
              upstreamProvider: u.upstreamProvider,
            },
          ])
        ),
        speakerSuggestions: result.editorial.speakers,
        status: "ready",
        summary: result.editorial.summary,
        topics: result.editorial.topics,
      })
      .where(
        and(
          eq(sourceAnalysis.id, claimed.analysisId),
          eq(sourceAnalysis.attempts, claimed.attempt),
          eq(sourceAnalysis.status, "processing")
        )
      )
      .returning({ id: sourceAnalysis.id });
    if (!finalized) {
      throw new Error("Source analysis attempt lost its finalization lease");
    }

    // Metering (cross-cutting rule 1): one ai_tokens entry per model call,
    // quantity = total tokens, estimated USD in metadata. Cost per
    // source-hour = SUM(metadata->>'costUsd') / hours — the exit metric.
    for (const usage of result.usage) {
      // biome-ignore lint/performance/noAwaitInLoops: at most two entries, same tx
      await recordUsage(tx, {
        correlationId: `analysis:${payload.sourceId}:${claimed.attempt}:${usage.task}`,
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
          sourceHours: durationSeconds / 3600,
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
}

export async function runAnalysis(
  payload: AnalysisPayload,
  options: { finalAttempt?: boolean } = {}
): Promise<void> {
  const claimed = await claimAnalysis(payload);
  if (!claimed) {
    return;
  }
  const stopHeartbeat = startAnalysisHeartbeat(payload, claimed);
  const capturedUsage: StructuredUsage[] = [];

  try {
    await captureStructuredUsage(capturedUsage, async () => {
      const transcript = await loadCurrentTranscript(
        payload.organizationId,
        payload.sourceId
      );
      if (!transcript) {
        throw new Error("Source has no ready transcript to analyze");
      }

      const speakerCount = new Set(
        transcript.data.words.map((word) => word.speaker).filter(Boolean)
      ).size;
      const context = await assembleContext(
        payload,
        transcript.data.language,
        speakerCount
      );

      const result = await runSourceAnalysis({
        contextPack: context.pack,
        durationMs: Math.round(context.durationSeconds * 1000),
        transcript: transcript.data,
      });

      await persistAnalysis(
        payload,
        claimed,
        context.pack,
        context.durationSeconds,
        result
      );

      // Extraction is the next follow-on job (the transcription→analysis
      // pattern, one level down): enqueued once the analysis is committed so
      // its passes can reuse the summary/chapters, errors contained — a
      // failed enqueue must not fail a finished analysis.
      try {
        const { enqueueExtraction } = await import(
          "@/lib/intelligence/extract-enqueue"
        );
        await enqueueExtraction(payload);
      } catch (error) {
        console.error(
          `[analysis] extraction enqueue failed for ${payload.sourceId}:`,
          error
        );
      }
    });
  } catch (error) {
    await recordAnalysisFailure(
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
