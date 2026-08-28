import { and, eq } from "drizzle-orm";
import {
  fineCutMoment,
  type MomentFineCut,
} from "@/lib/ai/capabilities/clip-fine-cut";
import {
  clipPrefixInput,
  type MomentAnalysisContext,
  type MomentSeed,
  runMomentDiscovery,
} from "@/lib/ai/capabilities/moment-discovery";
import {
  isFlaggedVerdict,
  type MomentReviewVerdict,
  reviewerEnabled,
  reviewMoments,
} from "@/lib/ai/capabilities/moment-review";
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
  momentDiscoveryRun,
  organization,
  project,
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
import { applyMomentFineCut } from "./fine-cut";
import { buildCutGrid, type CutGrid, cutterWindow } from "./grid";
import { tokenizeWords } from "./grounding";
import {
  buildMomentRows,
  type DedupeChunk,
  dedupeAndRankMomentRows,
  type MomentRow,
  spanText,
} from "./moments";

// The S6 discovery workflow, a structural clone of extract-pipeline.ts:
// claim → assemble context + seed inventory → one capability call →
// deterministic post-processing (snap/ground/dedupe/rank in moments.ts) →
// persist rows + metering. Same claim contract, same failure recording,
// runs under Trigger or the in-process dev fallback.
//
// Grounding stays the gate (AGENTS §Source intelligence): candidates whose
// anchor fails to align inside their snapped range persist with
// grounded=false for run stats but never surface.

const DISCOVER_ERROR_MAX_CHARS = 2000;

export interface DiscoveryPayload {
  organizationId: string;
  sourceId: string;
}

interface ClaimedRun {
  attempt: number;
  runId: string;
}

async function claimRun(payload: DiscoveryPayload): Promise<ClaimedRun | null> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [existing] = await tx
      .select({
        attempts: momentDiscoveryRun.attempts,
        id: momentDiscoveryRun.id,
        status: momentDiscoveryRun.status,
      })
      .from(momentDiscoveryRun)
      .where(eq(momentDiscoveryRun.sourceId, payload.sourceId))
      .limit(1);

    if (!existing) {
      const [created] = await tx
        .insert(momentDiscoveryRun)
        .values({
          attempts: 1,
          organizationId: payload.organizationId,
          sourceId: payload.sourceId,
          status: "processing",
        })
        .onConflictDoNothing({ target: momentDiscoveryRun.sourceId })
        .returning({ id: momentDiscoveryRun.id });
      return created ? { attempt: 1, runId: created.id } : null;
    }
    if (existing.status === "processing" || existing.status === "ready") {
      return null;
    }
    await tx
      .update(momentDiscoveryRun)
      .set({
        attempts: existing.attempts + 1,
        error: null,
        status: "processing",
      })
      .where(eq(momentDiscoveryRun.id, existing.id));
    return { attempt: existing.attempts + 1, runId: existing.id };
  });
}

// finalAttempt=false (a Trigger retry is coming) parks the row back in
// "pending" — claimable by the next attempt, rendered as still-working —
// instead of flashing a terminal "failed" between attempts (see
// extract-pipeline.ts, same contract).
async function recordRunFailure(
  payload: DiscoveryPayload,
  runId: string,
  error: unknown,
  finalAttempt: boolean
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown discovery failure";
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(momentDiscoveryRun)
      .set({
        error: sanitizeIngestError(message).slice(0, DISCOVER_ERROR_MAX_CHARS),
        status: finalAttempt ? "failed" : "pending",
      })
      .where(eq(momentDiscoveryRun.id, runId))
  );
}

interface DiscoveryContext {
  analysis: MomentAnalysisContext | null;
  durationSeconds: number;
  pack: SourceContextPack;
  seeds: MomentSeed[];
}

const SEED_LABEL_MAX_CHARS = 100;

function seedLabel(row: { payload: unknown; text: string }): string {
  const payload = (row.payload ?? {}) as { title?: string };
  const label = payload.title ?? row.text;
  return label.length > SEED_LABEL_MAX_CHARS
    ? `${label.slice(0, SEED_LABEL_MAX_CHARS)}…`
    : label;
}

async function assembleContext(
  payload: DiscoveryPayload,
  language: string | null,
  speakerCount: number
): Promise<DiscoveryContext> {
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
      throw new Error("Source is not ready for moment discovery");
    }

    // Analysis enriches the prefix when present; discovery still runs
    // without it (chained after extraction, but a failed analysis must not
    // block discovery forever).
    const [analysisRow] = await tx
      .select({
        id: sourceAnalysis.id,
        status: sourceAnalysis.status,
        summary: sourceAnalysis.summary,
      })
      .from(sourceAnalysis)
      .where(eq(sourceAnalysis.sourceId, payload.sourceId))
      .limit(1);
    let analysis: MomentAnalysisContext | null = null;
    if (analysisRow?.status === "ready") {
      const chapters = await tx
        .select({ startMs: sourceChapter.startMs, title: sourceChapter.title })
        .from(sourceChapter)
        .where(eq(sourceChapter.analysisId, analysisRow.id))
        .orderBy(sourceChapter.idx);
      analysis = { chapters, summary: analysisRow.summary };
    }

    // Seed inventory: grounded extractions only — the pass may cite their
    // ids in seedIds but is not limited to them.
    const seedRows = await tx
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
    const seeds: MomentSeed[] = seedRows.map((seed) => ({
      endMs: seed.endMs,
      id: seed.id,
      kind: seed.kind,
      label: seedLabel(seed),
      startMs: seed.startMs,
    }));

    const pack: SourceContextPack = {
      brand: row.brandName ? { name: row.brandName } : null,
      client: row.clientName ? { name: row.clientName } : null,
      kind: "moment-discovery",
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
    return { analysis, durationSeconds: row.durationSeconds, pack, seeds };
  });
}

// The Reviewer agent (S6 §9): cold verdicts over the surviving rows,
// attached before insert. Off unless MOMENT_REVIEWER=on (or mock mode,
// so the CI chain always proves it). A reviewer failure never fails
// discovery — verdicts are a quality layer over the human review, not a
// gate; unreviewed rows simply keep null review columns.
interface ReviewOutcome {
  // All verdict calls aggregated into ONE usage entry for the ledger
  usage: StructuredUsage | null;
  verdicts: Map<number, MomentReviewVerdict>;
}

const EMPTY_REVIEW: ReviewOutcome = { usage: null, verdicts: new Map() };

async function reviewSurvivors(
  rows: readonly MomentRow[],
  words: readonly TranscriptWord[]
): Promise<ReviewOutcome> {
  if (!reviewerEnabled()) {
    return EMPTY_REVIEW;
  }
  try {
    const reviewable = rows
      .map((row, index) => ({ index, row }))
      .filter(({ row }) => row.grounded && !row.suppressed);
    if (reviewable.length === 0) {
      return EMPTY_REVIEW;
    }
    const result = await reviewMoments(
      reviewable.map(({ index, row }) => ({
        hook: row.hook,
        id: String(index),
        lane: "moment" as const,
        spanText: spanText(words, row),
        title: row.title,
      }))
    );
    const verdicts = new Map<number, MomentReviewVerdict>();
    for (const [key, verdict] of result.verdicts) {
      verdicts.set(Number(key), verdict);
    }
    return { usage: sumUsage(result.usage), verdicts };
  } catch (error) {
    console.error("[discover] reviewer pass failed:", error);
    return EMPTY_REVIEW;
  }
}

// Stage progress written to the run row between passes: the silence-based
// reaper reads updated_at, and the cutting room's pipeline is long enough
// that a healthy run must keep visibly moving.
async function writeStage(
  payload: DiscoveryPayload,
  runId: string,
  stage: string
): Promise<void> {
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(momentDiscoveryRun)
      .set({ counts: { stage } })
      .where(eq(momentDiscoveryRun.id, runId))
  );
}

// The Cutter pass (§4 Pass 3) over the grounded, unsuppressed survivors:
// one fine-cut call per clip, bounded concurrency, failures leave coarse
// bounds standing (flagged `unrefined`). Returns the summed usage for the
// ledger.
async function fineCutSurvivors(
  rows: MomentRow[],
  grid: CutGrid,
  shotTimesMs: readonly number[],
  words: readonly TranscriptWord[],
  revisionNotes?: Map<MomentRow, string>
): Promise<StructuredUsage | null> {
  const tokens = tokenizeWords(words);
  const targets = rows
    .map((row, index) => ({ index, row }))
    .filter(({ row }) =>
      revisionNotes ? revisionNotes.has(row) : row.grounded && !row.suppressed
    );
  if (targets.length === 0) {
    return null;
  }
  // Revision windows are wider toward whatever the reviewer flagged —
  // one bounded re-cut, never a loop.
  const marginMs = revisionNotes ? 120_000 : undefined;
  const usages: StructuredUsage[] = [];
  await mapWithConcurrency(targets, FINE_CUT_CONCURRENCY, async (target) => {
    let cut: MomentFineCut | null = null;
    try {
      const outcome = await fineCutMoment({
        grid,
        hook: target.row.hook,
        revisionNote: revisionNotes?.get(target.row) ?? null,
        roughRange: { endMs: target.row.endMs, startMs: target.row.startMs },
        shotTimesMs,
        title: target.row.title,
        window: cutterWindow(
          grid,
          { endMs: target.row.endMs, startMs: target.row.startMs },
          marginMs
        ),
      });
      ({ cut } = outcome);
      if (outcome.usage) {
        usages.push(outcome.usage);
      }
    } catch (error) {
      console.error(
        `[discover] fine cut failed for "${target.row.title}":`,
        error
      );
    }
    const before = {
      endMs: target.row.endMs,
      startMs: target.row.startMs,
    };
    const updated = applyMomentFineCut(
      target.row,
      cut,
      grid,
      shotTimesMs,
      tokens
    );
    if (
      revisionNotes &&
      (updated.startMs !== before.startMs || updated.endMs !== before.endMs) &&
      !updated.flags.includes("revised")
    ) {
      updated.flags.push("revised");
    }
    // Assign in place: verdicts and revision notes key by row IDENTITY,
    // which must survive the cut.
    Object.assign(target.row, updated);
  });
  return sumUsage(usages);
}

// Fixes that route back through the Cutter for the ONE bounded revision
// (§4 Pass 6). retitle/drop stay pure flags for the human.
const REVISION_FIXES = new Set([
  "extend_start",
  "trim_start",
  "trim_end",
  "extend_end",
]);

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

// Chunk vectors for the semantic dedupe pass. An index that isn't ready is
// not a failure — range-IoU dedupe still runs without vectors.
async function loadDedupeChunks(
  payload: DiscoveryPayload
): Promise<DedupeChunk[]> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const rows = await tx
      .select({
        embedding: transcriptChunk.embedding,
        endMs: transcriptChunk.endMs,
        startMs: transcriptChunk.startMs,
      })
      .from(transcriptChunk)
      .where(eq(transcriptChunk.sourceId, payload.sourceId))
      .orderBy(transcriptChunk.idx);
    return rows;
  });
}

export async function runDiscovery(
  payload: DiscoveryPayload,
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
      throw new Error("Source has no ready transcript to discover from");
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

    // The cutting room (docs/clip-cut-architecture.md §4): brief → rough
    // cut → deterministic gauntlet → per-clip Cutter → cold review → one
    // bounded revision. Stage names on the run row keep the reaper's
    // silence window honest across the longer pipeline.
    const grid = buildCutGrid(transcript.data.words);
    const shotTimesMs = await loadShotTimes(payload);

    await writeStage(payload, claimed.runId, "brief");
    const ensured = await ensureEpisodeBrief(
      payload,
      clipPrefixInput(
        {
          analysis: context.analysis,
          contextPack: context.pack,
          seeds: context.seeds,
        },
        grid
      ),
      transcript.revision
    );

    await writeStage(payload, claimed.runId, "rough");
    const result = await runMomentDiscovery(
      {
        analysis: context.analysis,
        contextPack: context.pack,
        durationMs,
        seeds: context.seeds,
        transcript: transcript.data,
      },
      { brief: ensured.brief }
    );

    // seedIds the model invented (not in the inventory it was shown) are
    // dropped deterministically — citations must reference real rows.
    const knownSeedIds = new Set(context.seeds.map((seed) => seed.id));
    const items = result.items.map((item) => ({
      ...item,
      seedIds: item.seedIds.filter((id) => knownSeedIds.has(id)),
    }));

    const chunks = await loadDedupeChunks(payload);
    let rows = buildMomentRows(
      items,
      transcript.data.words,
      durationMs,
      chunks
    );

    await writeStage(payload, claimed.runId, "cut");
    const cutUsage = await fineCutSurvivors(
      rows,
      grid,
      shotTimesMs,
      transcript.data.words
    );
    // Refined boundaries can converge two candidates — dedupe re-runs.
    rows = dedupeAndRankMomentRows(rows, chunks);

    await writeStage(payload, claimed.runId, "review");
    const review = await reviewSurvivors(rows, transcript.data.words);
    // Verdicts keyed by row IDENTITY, not index — the revision round and
    // its re-rank reorder the array.
    const verdictByRow = new Map<MomentRow, MomentReviewVerdict>();
    for (const [index, verdict] of review.verdicts) {
      const row = rows[index];
      if (row) {
        verdictByRow.set(row, verdict);
      }
    }

    await writeStage(payload, claimed.runId, "revise");
    const revisionNotes = new Map<MomentRow, string>();
    for (const [row, verdict] of verdictByRow) {
      if (REVISION_FIXES.has(verdict.suggestedFix)) {
        revisionNotes.set(row, `${verdict.suggestedFix}: ${verdict.notes}`);
      }
    }
    const reviseUsage =
      revisionNotes.size > 0
        ? await fineCutSurvivors(
            rows,
            grid,
            shotTimesMs,
            transcript.data.words,
            revisionNotes
          )
        : null;
    rows = dedupeAndRankMomentRows(rows, chunks);

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

      // Re-runs replace: candidates belong to exactly one run per source.
      // (The rerun ACTION refuses while human decisions exist — decided
      // rows are the M1 record — so this delete only ever clears
      // undecided proposals.)
      await tx
        .delete(momentCandidate)
        .where(eq(momentCandidate.sourceId, payload.sourceId));
      if (rows.length > 0) {
        await tx.insert(momentCandidate).values(
          rows.map((row) => ({
            ...row,
            ...verdictColumns(verdictByRow.get(row)),
            organizationId: payload.organizationId,
            revision: transcript.revision,
            runId: claimed.runId,
            sourceId: payload.sourceId,
          }))
        );
      }

      await tx
        .update(momentDiscoveryRun)
        .set({
          contextSnapshotId: snapshot?.id ?? null,
          counts: {
            flagged: [...review.verdicts.values()].filter(isFlaggedVerdict)
              .length,
            grounded: rows.filter((row) => row.grounded).length,
            proposed: rows.length,
            reviewed: review.verdicts.size,
            revised: rows.filter((row) => row.flags.includes("revised")).length,
            suppressed: rows.filter((row) => row.suppressed).length,
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
        .where(eq(momentDiscoveryRun.id, claimed.runId));

      // The cutting room's per-clip passes: each summed into one ledger
      // entry (the reviewer's pattern) — the ledger meters the pass,
      // Langfuse holds the per-call detail.
      const summedPasses: [string, StructuredUsage | null, number][] = [
        [
          `discover:${payload.sourceId}:${claimed.attempt}:brief`,
          ensured.usage,
          1,
        ],
        [
          `discover:${payload.sourceId}:${claimed.attempt}:cut`,
          cutUsage,
          rows.filter((row) => row.grounded && !row.suppressed).length,
        ],
        [
          `discover:${payload.sourceId}:${claimed.attempt}:revise`,
          reviseUsage,
          revisionNotes.size,
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

      // Reviewer spend: all verdict calls summed into one entry — the
      // ledger meters the pass, Langfuse holds the per-call detail.
      if (review.usage) {
        await recordUsage(tx, {
          correlationId: `discover:${payload.sourceId}:${claimed.attempt}:review`,
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

      // Metering (cross-cutting rule 1): one ai_tokens entry per call.
      for (const usage of result.usage) {
        // biome-ignore lint/performance/noAwaitInLoops: at most one entry, same tx
        await recordUsage(tx, {
          correlationId: `discover:${payload.sourceId}:${claimed.attempt}`,
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
