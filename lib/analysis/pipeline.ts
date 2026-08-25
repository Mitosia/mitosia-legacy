import { eq } from "drizzle-orm";
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
import { withOrgScope } from "@/lib/db/tenant";
import { recordUsage } from "@/lib/ledger";
import { sanitizeIngestError } from "@/lib/media/ingest-error";
import { loadCurrentTranscript } from "@/lib/transcription/store";

// The S4 analysis workflow: claim → assemble + snapshot the context pack →
// run the capability → persist chapters/editorial + metering. Mirrors
// lib/transcription/pipeline.ts exactly: same claim contract, same failure
// recording, runs under Trigger or the in-process dev fallback.

const ANALYSIS_ERROR_MAX_CHARS = 2000;

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

    if (!existing) {
      const [created] = await tx
        .insert(sourceAnalysis)
        .values({
          attempts: 1,
          organizationId: payload.organizationId,
          sourceId: payload.sourceId,
          status: "processing",
        })
        .onConflictDoNothing({ target: sourceAnalysis.sourceId })
        .returning({ id: sourceAnalysis.id });
      return created ? { analysisId: created.id, attempt: 1 } : null;
    }
    if (existing.status === "processing" || existing.status === "ready") {
      return null;
    }
    await tx
      .update(sourceAnalysis)
      .set({
        attempts: existing.attempts + 1,
        error: null,
        status: "processing",
      })
      .where(eq(sourceAnalysis.id, existing.id));
    return { analysisId: existing.id, attempt: existing.attempts + 1 };
  });
}

// finalAttempt=false (a Trigger retry is coming) parks the row back in
// "pending" instead of flashing a terminal "failed" between attempts (see
// lib/intelligence/extract-pipeline.ts, same contract).
async function recordAnalysisFailure(
  payload: AnalysisPayload,
  analysisId: string,
  error: unknown,
  finalAttempt: boolean
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown analysis failure";
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(sourceAnalysis)
      .set({
        error: sanitizeIngestError(message).slice(0, ANALYSIS_ERROR_MAX_CHARS),
        status: finalAttempt ? "failed" : "pending",
      })
      .where(eq(sourceAnalysis.id, analysisId))
  );
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

    await tx
      .update(sourceAnalysis)
      .set({
        contextSnapshotId: snapshot?.id ?? null,
        entities: result.editorial.entities,
        error: null,
        models: Object.fromEntries(
          result.usage.map((u) => [
            u.task,
            { model: u.model, provider: u.provider },
          ])
        ),
        speakerSuggestions: result.editorial.speakers,
        status: "ready",
        summary: result.editorial.summary,
        topics: result.editorial.topics,
      })
      .where(eq(sourceAnalysis.id, claimed.analysisId));

    // Metering (cross-cutting rule 1): one ai_tokens entry per model call,
    // quantity = total tokens, estimated USD in metadata. Cost per
    // source-hour = SUM(metadata->>'costUsd') / hours — the exit metric.
    for (const usage of result.usage) {
      // biome-ignore lint/performance/noAwaitInLoops: at most two entries, same tx
      await recordUsage(tx, {
        correlationId: `analysis:${payload.sourceId}:${claimed.attempt}:${usage.task}`,
        entryType: "ai_tokens",
        metadata: {
          costUsd: usage.costUsd,
          inputTokens: usage.inputTokens,
          model: usage.model,
          outputTokens: usage.outputTokens,
          provider: usage.provider,
          sourceHours: durationSeconds / 3600,
          task: usage.task,
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

  try {
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
  } catch (error) {
    await recordAnalysisFailure(
      payload,
      claimed.analysisId,
      error,
      options.finalAttempt ?? true
    );
    throw error;
  }
}
