import { and, eq } from "drizzle-orm";
import { fineCutSegmentBoundary } from "@/lib/ai/capabilities/clip-fine-cut";
import {
  clipPrefixInput,
  type MomentSeed,
} from "@/lib/ai/capabilities/moment-discovery";
import {
  isFlaggedVerdict,
  type MomentReviewVerdict,
  reviewerEnabled,
  reviewMoments,
} from "@/lib/ai/capabilities/moment-review";
import {
  type RawSegmentItem,
  runSegmentPlan,
  type SegmentPlanInput,
} from "@/lib/ai/capabilities/segment-plan";
import {
  canonicalJson,
  hashContextPack,
  type SourceContextPack,
} from "@/lib/ai/context";
import type { StructuredUsage } from "@/lib/ai/generate";
import {
  brand,
  campaign,
  client,
  contextSnapshot,
  momentCandidate,
  organization,
  project,
  segmentClip,
  segmentPlanRun,
  source,
  sourceAnalysis,
  sourceChapter,
  sourceExtraction,
  transcriptChunk,
} from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { recordUsage } from "@/lib/ledger";
import { sanitizeIngestError } from "@/lib/media/ingest-error";
import { loadCurrentTranscript } from "@/lib/transcription/store";
import type { TranscriptWord } from "@/lib/transcription/types";
import {
  ensureEpisodeBrief,
  FINE_CUT_CONCURRENCY,
  loadShotTimes,
  mapWithConcurrency,
} from "./clip-support";
import { buildCutGrid, type CutGrid, cutterWindow } from "./grid";
import { type DedupeChunk, spanText } from "./moments";
import { buildSegmentRows, type SegmentRow } from "./segments";

// The S6.5 segment-plan workflow, the discover-pipeline clone one lane
// over: claim → assemble context + inventories → ONE partition pass →
// deterministic tiling gauntlet (lib/intelligence/segments.ts) → cold
// reviewer over the keeps → persist rows + metering. NOT chained from any
// job — planning is a human's button (it leads toward spend-gated
// rendering), so the only entries are the action and the rerun action.

const SEGMENT_ERROR_MAX_CHARS = 2000;

export interface SegmentPlanPayload {
  organizationId: string;
  sourceId: string;
}

interface ClaimedRun {
  attempt: number;
  runId: string;
}

async function claimRun(
  payload: SegmentPlanPayload
): Promise<ClaimedRun | null> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [existing] = await tx
      .select({
        attempts: segmentPlanRun.attempts,
        id: segmentPlanRun.id,
        status: segmentPlanRun.status,
      })
      .from(segmentPlanRun)
      .where(eq(segmentPlanRun.sourceId, payload.sourceId))
      .limit(1);

    if (!existing) {
      const [created] = await tx
        .insert(segmentPlanRun)
        .values({
          attempts: 1,
          organizationId: payload.organizationId,
          sourceId: payload.sourceId,
          status: "processing",
        })
        .onConflictDoNothing({ target: segmentPlanRun.sourceId })
        .returning({ id: segmentPlanRun.id });
      return created ? { attempt: 1, runId: created.id } : null;
    }
    if (existing.status === "processing" || existing.status === "ready") {
      return null;
    }
    await tx
      .update(segmentPlanRun)
      .set({
        attempts: existing.attempts + 1,
        error: null,
        status: "processing",
      })
      .where(eq(segmentPlanRun.id, existing.id));
    return { attempt: existing.attempts + 1, runId: existing.id };
  });
}

// finalAttempt=false parks the row back in "pending" between Trigger
// attempts (the #85 contract — see extract-pipeline.ts).
async function recordRunFailure(
  payload: SegmentPlanPayload,
  runId: string,
  error: unknown,
  finalAttempt: boolean
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown segment-plan failure";
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(segmentPlanRun)
      .set({
        error: sanitizeIngestError(message).slice(0, SEGMENT_ERROR_MAX_CHARS),
        status: finalAttempt ? "failed" : "pending",
      })
      .where(eq(segmentPlanRun.id, runId))
  );
}

const SEED_LABEL_MAX_CHARS = 100;

function truncateLabel(label: string): string {
  return label.length > SEED_LABEL_MAX_CHARS
    ? `${label.slice(0, SEED_LABEL_MAX_CHARS)}…`
    : label;
}

interface PlanContext {
  durationSeconds: number;
  input: Omit<SegmentPlanInput, "durationMs" | "transcript">;
}

async function assembleContext(
  payload: SegmentPlanPayload,
  language: string | null,
  speakerCount: number
): Promise<PlanContext> {
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
      throw new Error("Source is not ready for segment planning");
    }

    const [analysisRow] = await tx
      .select({
        id: sourceAnalysis.id,
        status: sourceAnalysis.status,
        summary: sourceAnalysis.summary,
      })
      .from(sourceAnalysis)
      .where(eq(sourceAnalysis.sourceId, payload.sourceId))
      .limit(1);
    let analysis: SegmentPlanInput["analysis"] = null;
    if (analysisRow?.status === "ready") {
      const chapters = await tx
        .select({ startMs: sourceChapter.startMs, title: sourceChapter.title })
        .from(sourceChapter)
        .where(eq(sourceChapter.analysisId, analysisRow.id))
        .orderBy(sourceChapter.idx);
      analysis = { chapters, summary: analysisRow.summary };
    }

    const extractionRows = await tx
      .select({
        endMs: sourceExtraction.endMs,
        id: sourceExtraction.id,
        kind: sourceExtraction.kind,
        payload: sourceExtraction.payload,
        startMs: sourceExtraction.startMs,
        text: sourceExtraction.text,
      })
      .from(sourceExtraction)
      .where(
        and(
          eq(sourceExtraction.sourceId, payload.sourceId),
          eq(sourceExtraction.grounded, true)
        )
      )
      .orderBy(sourceExtraction.startMs);
    const seeds: MomentSeed[] = extractionRows.map((seed) => ({
      endMs: seed.endMs,
      id: seed.id,
      kind: seed.kind,
      label: truncateLabel(
        ((seed.payload ?? {}) as { title?: string }).title ?? seed.text
      ),
      startMs: seed.startMs,
    }));

    // Grounded, unsuppressed moments as arc-peak hints — a keep segment
    // usually wraps one or more of these.
    const momentRows = await tx
      .select({
        endMs: momentCandidate.endMs,
        id: momentCandidate.id,
        startMs: momentCandidate.startMs,
        title: momentCandidate.title,
      })
      .from(momentCandidate)
      .where(
        and(
          eq(momentCandidate.sourceId, payload.sourceId),
          eq(momentCandidate.grounded, true),
          eq(momentCandidate.suppressed, false)
        )
      )
      .orderBy(momentCandidate.startMs);
    const momentInventory: MomentSeed[] = momentRows.map((moment) => ({
      endMs: moment.endMs,
      id: moment.id,
      kind: "moment",
      label: truncateLabel(moment.title),
      startMs: moment.startMs,
    }));

    const pack: SourceContextPack = {
      brand: row.brandName ? { name: row.brandName } : null,
      client: row.clientName ? { name: row.clientName } : null,
      kind: "segment-plan",
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
    return {
      durationSeconds: row.durationSeconds,
      input: { analysis, contextPack: pack, momentInventory, seeds },
    };
  });
}

async function loadDedupeChunks(
  payload: SegmentPlanPayload
): Promise<DedupeChunk[]> {
  return await withOrgScope(payload.organizationId, (tx) =>
    tx
      .select({
        embedding: transcriptChunk.embedding,
        endMs: transcriptChunk.endMs,
        startMs: transcriptChunk.startMs,
      })
      .from(transcriptChunk)
      .where(eq(transcriptChunk.sourceId, payload.sourceId))
      .orderBy(transcriptChunk.idx)
  );
}

interface ReviewOutcome {
  usage: StructuredUsage | null;
  verdicts: Map<number, MomentReviewVerdict>;
}

const EMPTY_REVIEW: ReviewOutcome = { usage: null, verdicts: new Map() };

function sumUsage(usages: readonly StructuredUsage[]): StructuredUsage | null {
  const [first] = usages;
  if (!first) {
    return null;
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  for (const entry of usages) {
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
    if (entry.costUsd !== null) {
      costUsd = (costUsd ?? 0) + entry.costUsd;
    }
  }
  return { ...first, costUsd, inputTokens, outputTokens };
}

// Cold reviewer over the KEEP segments — the same agent, same flag, same
// never-a-gate contract as the moments lane.
async function reviewKeeps(
  rows: readonly SegmentRow[],
  words: readonly TranscriptWord[]
): Promise<ReviewOutcome> {
  if (!reviewerEnabled()) {
    return EMPTY_REVIEW;
  }
  try {
    const reviewable = rows
      .map((row, index) => ({ index, row }))
      .filter(({ row }) => row.kind === "keep" && row.grounded);
    if (reviewable.length === 0) {
      return EMPTY_REVIEW;
    }
    const result = await reviewMoments(
      reviewable.map(({ index, row }) => ({
        hook: row.hook ?? "",
        id: String(index),
        lane: "chapter" as const,
        spanText: spanText(words, row),
        title: row.title ?? "",
      }))
    );
    const verdicts = new Map<number, MomentReviewVerdict>();
    for (const [key, verdict] of result.verdicts) {
      verdicts.set(Number(key), verdict);
    }
    return { usage: sumUsage(result.usage), verdicts };
  } catch (error) {
    console.error("[segments] reviewer pass failed:", error);
    return EMPTY_REVIEW;
  }
}

function verdictColumns(verdict: MomentReviewVerdict | undefined) {
  if (!verdict) {
    return {};
  }
  return {
    reviewFix: verdict.suggestedFix,
    reviewNotes: verdict.notes,
    reviewScores: {
      opensCold: verdict.opensCold,
      resolves: verdict.resolves,
      standsAlone: verdict.standsAlone,
      titleTruthful: verdict.titleTruthful,
    },
  };
}

async function writeStage(
  payload: SegmentPlanPayload,
  runId: string,
  stage: string
): Promise<void> {
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(segmentPlanRun)
      .set({ counts: { stage } })
      .where(eq(segmentPlanRun.id, runId))
  );
}

const SEGMENT_CUT_MARGIN_MS = 60_000;

function boundaryTitle(item: RawSegmentItem | undefined): string {
  if (!item) {
    return "(episode start)";
  }
  if (item.kind === "drop") {
    return `(dropped: ${item.dropReason ?? "other"})`;
  }
  return item.title ?? "(untitled chapter)";
}

// Per-cut refinement (§4 Pass 3, segments): each boundary between
// proposed spans gets one small call over a ±60s window showing BOTH
// sides — including adjacent drop text, so a keep never opens on a
// sponsor read's tail. Refined cuts re-enter buildSegmentRows, so the
// partition invariant survives untouched. Failures keep the rough cut.
async function refineSegmentCuts(
  items: RawSegmentItem[],
  grid: CutGrid,
  shotTimesMs: readonly number[],
  firstWord: TranscriptWord | undefined
): Promise<{ calls: number; usage: StructuredUsage | null }> {
  const firstWordMs = firstWord ? firstWord.startMs : 0;
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
  const targets = sorted
    .map((item, index) => ({ index, item }))
    .filter(({ index, item }) => index > 0 || item.startMs > firstWordMs);
  if (targets.length === 0) {
    return { calls: 0, usage: null };
  }
  const usages: StructuredUsage[] = [];
  await mapWithConcurrency(targets, FINE_CUT_CONCURRENCY, async (target) => {
    try {
      const outcome = await fineCutSegmentBoundary({
        afterTitle: boundaryTitle(target.item),
        beforeTitle: boundaryTitle(sorted[target.index - 1]),
        grid,
        roughCutMs: target.item.startMs,
        shotTimesMs,
        window: cutterWindow(
          grid,
          { endMs: target.item.startMs, startMs: target.item.startMs },
          SEGMENT_CUT_MARGIN_MS
        ),
      });
      if (outcome.usage) {
        usages.push(outcome.usage);
      }
      const sentence =
        grid.sentences[
          Math.max(0, Math.min(outcome.cut.cutId, grid.sentences.length - 1))
        ];
      if (sentence) {
        target.item.startMs = sentence.startMs;
      }
    } catch (error) {
      console.error(
        `[segments] cut refinement failed near ${target.item.startMs}ms:`,
        error
      );
    }
  });
  return { calls: targets.length, usage: sumUsage(usages) };
}

export async function runSegmentPlanPipeline(
  payload: SegmentPlanPayload,
  options: { finalAttempt?: boolean } = {}
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
      throw new Error("Source has no ready transcript to plan from");
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

    // The cutting room, chapters lane (§4): persisted brief → TOC-first
    // rough partition → per-cut refinement seeing both sides → tiling
    // gauntlet → cold review. Planning stays a button; the brief row is
    // the cross-run memory when the prompt cache has gone cold.
    const grid = buildCutGrid(transcript.data.words);
    const shotTimesMs = await loadShotTimes(payload);

    await writeStage(payload, claimed.runId, "brief");
    const ensured = await ensureEpisodeBrief(
      payload,
      clipPrefixInput(
        {
          analysis: context.input.analysis,
          contextPack: context.input.contextPack,
          seeds: context.input.seeds,
        },
        grid
      ),
      transcript.revision
    );

    await writeStage(payload, claimed.runId, "rough");
    const result = await runSegmentPlan(
      {
        ...context.input,
        durationMs,
        transcript: transcript.data,
      },
      { brief: ensured.brief }
    );

    await writeStage(payload, claimed.runId, "cut");
    const items = result.items.map((item) => ({ ...item }));
    const refinement = await refineSegmentCuts(
      items,
      grid,
      shotTimesMs,
      transcript.data.words[0]
    );

    const chunks = await loadDedupeChunks(payload);
    const rows = buildSegmentRows(
      items,
      transcript.data.words,
      durationMs,
      chunks
    );
    await writeStage(payload, claimed.runId, "review");
    const review = await reviewKeeps(rows, transcript.data.words);

    await withOrgScope(payload.organizationId, async (tx) => {
      const [snapshot] = await tx
        .insert(contextSnapshot)
        .values({
          content: JSON.parse(canonicalJson(context.input.contextPack)),
          hash: hashContextPack(context.input.contextPack),
          kind: context.input.contextPack.kind,
          organizationId: payload.organizationId,
        })
        .returning({ id: contextSnapshot.id });

      // Re-plans replace (the rerun ACTION refuses while decisions exist).
      await tx
        .delete(segmentClip)
        .where(eq(segmentClip.sourceId, payload.sourceId));
      if (rows.length > 0) {
        await tx.insert(segmentClip).values(
          rows.map((row, index) => ({
            ...row,
            ...verdictColumns(review.verdicts.get(index)),
            organizationId: payload.organizationId,
            revision: transcript.revision,
            runId: claimed.runId,
            sourceId: payload.sourceId,
          }))
        );
      }

      await tx
        .update(segmentPlanRun)
        .set({
          contextSnapshotId: snapshot?.id ?? null,
          counts: {
            dropped: rows.filter((row) => row.kind === "drop").length,
            flagged: [...review.verdicts.values()].filter(isFlaggedVerdict)
              .length,
            grounded: rows.filter((row) => row.grounded).length,
            kept: rows.filter((row) => row.kind === "keep").length,
            refinedCuts: refinement.calls,
            reviewed: review.verdicts.size,
            segments: rows.length,
            toc: result.tableOfContents,
          },
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
        .where(eq(segmentPlanRun.id, claimed.runId));

      const summedPasses: [string, StructuredUsage | null, number][] = [
        [
          `segment:${payload.sourceId}:${claimed.attempt}:brief`,
          ensured.usage,
          1,
        ],
        [
          `segment:${payload.sourceId}:${claimed.attempt}:cut`,
          refinement.usage,
          refinement.calls,
        ],
      ];
      for (const [correlationId, usage, calls] of summedPasses) {
        if (!usage) {
          continue;
        }
        // biome-ignore lint/performance/noAwaitInLoops: few entries, same tx
        await recordUsage(tx, {
          correlationId,
          entryType: "ai_tokens",
          metadata: {
            calls,
            costUsd: usage.costUsd,
            inputTokens: usage.inputTokens,
            model: usage.model,
            outputTokens: usage.outputTokens,
            provider: usage.provider,
            task: usage.task,
          },
          organizationId: payload.organizationId,
          quantity: usage.inputTokens + usage.outputTokens,
          sourceId: payload.sourceId,
          unit: "tokens",
        });
      }

      if (review.usage) {
        await recordUsage(tx, {
          correlationId: `segment:${payload.sourceId}:${claimed.attempt}:review`,
          entryType: "ai_tokens",
          metadata: {
            calls: review.verdicts.size,
            costUsd: review.usage.costUsd,
            inputTokens: review.usage.inputTokens,
            model: review.usage.model,
            outputTokens: review.usage.outputTokens,
            provider: review.usage.provider,
            task: "moment-review.verdict",
          },
          organizationId: payload.organizationId,
          quantity: review.usage.inputTokens + review.usage.outputTokens,
          sourceId: payload.sourceId,
          unit: "tokens",
        });
      }

      for (const usage of result.usage) {
        // biome-ignore lint/performance/noAwaitInLoops: one entry, same tx
        await recordUsage(tx, {
          correlationId: `segment:${payload.sourceId}:${claimed.attempt}`,
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
