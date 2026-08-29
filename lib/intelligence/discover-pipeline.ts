import { and, eq, sql } from "drizzle-orm";
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
import {
  captureStructuredUsage,
  type StructuredUsage,
  structuredFailureUsages,
  summarizeStructuredUsages,
  sumStructuredUsage,
} from "@/lib/ai/generate";
import { recordStructuredUsages } from "@/lib/ai/metering";
import { recordAudit } from "@/lib/audit";
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
import { type OrgTransaction, withOrgScope } from "@/lib/db/tenant";
import { sanitizeIngestError } from "@/lib/media/ingest-error";
import { loadCurrentTranscript } from "@/lib/transcription/store";
import type { TranscriptWord } from "@/lib/transcription/types";
import {
  ensureEpisodeBrief,
  FINE_CUT_CONCURRENCY,
  loadShotTimes,
  mapWithConcurrency,
} from "./clip-support";
import { terminalDiscoveryFailureStatus } from "./discovery-state";
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
const DISCOVERY_HEARTBEAT_INTERVAL_MS = 60_000;
const DISCOVERY_USAGE_SUFFIXES: Partial<
  Record<StructuredUsage["task"], string>
> = {
  "clip-fine.cut": ":cut",
  "episode-brief.compose": ":brief",
  "moment-discovery.candidates": "",
  "moment-review.verdict": ":review",
};

function discoveryUsageCorrelation(
  sourceId: string,
  attempt: number,
  task: StructuredUsage["task"]
): string {
  const suffix = DISCOVERY_USAGE_SUFFIXES[task] ?? `:${task}`;
  return `discover:${sourceId}:${attempt}${suffix}`;
}

export interface DiscoveryPayload {
  dispatchLease: string;
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
      return null;
    }
    // Only an explicitly queued run is claimable. A failed or ready run needs
    // a new human/automatic transition and lease; accepting a delayed task
    // directly from either state would resurrect a retired attempt.
    if (existing.status !== "pending") {
      return null;
    }
    const [claimed] = await tx
      .update(momentDiscoveryRun)
      .set({
        attempts: existing.attempts + 1,
        error: null,
        status: "processing",
      })
      .where(
        and(
          eq(momentDiscoveryRun.id, existing.id),
          eq(momentDiscoveryRun.attempts, existing.attempts),
          sql`${momentDiscoveryRun.counts}->>'dispatchLease' = ${payload.dispatchLease}`,
          eq(momentDiscoveryRun.status, existing.status)
        )
      )
      .returning({ id: momentDiscoveryRun.id });
    return claimed
      ? { attempt: existing.attempts + 1, runId: existing.id }
      : null;
  });
}

// finalAttempt=false (a Trigger retry is coming) parks the row back in
// "pending" — claimable by the next attempt, rendered as still-working —
// instead of flashing a terminal "failed" between attempts (see
// extract-pipeline.ts, same contract).
async function recordRunFailure(
  payload: DiscoveryPayload,
  claimed: ClaimedRun,
  error: unknown,
  finalAttempt: boolean,
  capturedUsage: readonly StructuredUsage[]
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown discovery failure";
  const safeMessage = sanitizeIngestError(message).slice(
    0,
    DISCOVER_ERROR_MAX_CHARS
  );
  const failedUsages = structuredFailureUsages(error, capturedUsage);
  await withOrgScope(payload.organizationId, async (tx) => {
    const [updated] = await tx
      .update(momentDiscoveryRun)
      .set({
        error: safeMessage,
        status: finalAttempt ? terminalDiscoveryFailureStatus : "pending",
      })
      .where(
        and(
          eq(momentDiscoveryRun.id, claimed.runId),
          eq(momentDiscoveryRun.attempts, claimed.attempt),
          eq(momentDiscoveryRun.status, "processing")
        )
      )
      .returning({
        id: momentDiscoveryRun.id,
        status: momentDiscoveryRun.status,
      });
    await recordStructuredUsages(tx, {
      correlationForTask: (task) =>
        discoveryUsageCorrelation(payload.sourceId, claimed.attempt, task),
      failed: true,
      organizationId: payload.organizationId,
      sourceId: payload.sourceId,
      usages: failedUsages,
    });
    if (updated?.status === "ready") {
      await recordAudit(tx, {
        action: "moment_discovery.refresh_failed_preserved",
        actorUserId: null,
        entityId: updated.id,
        entityType: "moment_discovery_run",
        metadata: { attempt: claimed.attempt, sourceId: payload.sourceId },
        organizationId: payload.organizationId,
      });
    }
  });
}

async function heartbeatDiscoveryRun(
  payload: DiscoveryPayload,
  claimed: ClaimedRun
): Promise<boolean> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [touched] = await tx
      .update(momentDiscoveryRun)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(momentDiscoveryRun.id, claimed.runId),
          eq(momentDiscoveryRun.attempts, claimed.attempt),
          eq(momentDiscoveryRun.status, "processing")
        )
      )
      .returning({ id: momentDiscoveryRun.id });
    return Boolean(touched);
  });
}

// Recursive timeout instead of setInterval: a slow database heartbeat never
// overlaps the next one. The stop function also awaits the one in flight so
// no timer survives finalization or failure recording.
function startDiscoveryRunHeartbeat(
  payload: DiscoveryPayload,
  claimed: ClaimedRun
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      inFlight = heartbeatDiscoveryRun(payload, claimed)
        .then((active) => {
          if (!active) {
            stopped = true;
          }
        })
        .catch((error) => {
          console.error(
            `[discover] heartbeat failed for run ${claimed.runId}:`,
            error
          );
        })
        .finally(() => {
          inFlight = null;
          schedule();
        });
    }, DISCOVERY_HEARTBEAT_INTERVAL_MS);
    timer.unref();
  };
  schedule();
  return async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await inFlight;
  };
}

async function assertActiveAttempt(
  tx: OrgTransaction,
  claimed: ClaimedRun
): Promise<{ editVersion: number }> {
  await tx.execute(
    sql`SELECT ${momentDiscoveryRun.id} FROM ${momentDiscoveryRun} WHERE ${momentDiscoveryRun.id} = ${claimed.runId} FOR UPDATE`
  );
  const [active] = await tx
    .select({ editVersion: momentDiscoveryRun.editVersion })
    .from(momentDiscoveryRun)
    .where(
      and(
        eq(momentDiscoveryRun.id, claimed.runId),
        eq(momentDiscoveryRun.attempts, claimed.attempt),
        eq(momentDiscoveryRun.status, "processing")
      )
    )
    .limit(1);
  if (!active) {
    throw new Error("Moment discovery attempt is no longer active");
  }
  return active;
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
    return { usage: sumStructuredUsage(result.usage), verdicts };
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
  claimed: ClaimedRun,
  stage: string
): Promise<void> {
  const active = await withOrgScope(payload.organizationId, async (tx) => {
    const [updated] = await tx
      .update(momentDiscoveryRun)
      .set({
        counts: sql`(
          COALESCE(${momentDiscoveryRun.counts}, '{}'::jsonb)
          - 'dispatchState' - 'dispatchId' - 'dispatchedAt'
        ) || jsonb_build_object(
          'dispatchLease', ${payload.dispatchLease}::text,
          'stage', ${stage}::text
        )`,
      })
      .where(
        and(
          eq(momentDiscoveryRun.id, claimed.runId),
          eq(momentDiscoveryRun.attempts, claimed.attempt),
          eq(momentDiscoveryRun.status, "processing")
        )
      )
      .returning({ id: momentDiscoveryRun.id });
    return Boolean(updated);
  });
  if (!active) {
    throw new Error("Moment discovery attempt is no longer active");
  }
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
  return sumStructuredUsage(usages);
}

// Fixes that route back through the Cutter for the ONE bounded revision
// (§4 Pass 6). retitle/drop stay pure flags for the human.
const REVISION_FIXES = new Set([
  "extend_start",
  "trim_start",
  "trim_end",
  "extend_end",
]);

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
  const stopHeartbeat = startDiscoveryRunHeartbeat(payload, claimed);
  const capturedUsage: StructuredUsage[] = [];

  try {
    await captureStructuredUsage(capturedUsage, async () => {
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

      await writeStage(payload, claimed, "brief");
      const ensured = await ensureEpisodeBrief(
        {
          ...payload,
          usageCorrelationId: `discover:${payload.sourceId}:${claimed.attempt}:brief`,
        },
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

      await writeStage(payload, claimed, "rough");
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

      await writeStage(payload, claimed, "cut");
      await fineCutSurvivors(rows, grid, shotTimesMs, transcript.data.words);
      // Refined boundaries can converge two candidates — dedupe re-runs.
      rows = dedupeAndRankMomentRows(rows, chunks);

      await writeStage(payload, claimed, "review");
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

      await writeStage(payload, claimed, "revise");
      const revisionNotes = new Map<MomentRow, string>();
      for (const [row, verdict] of verdictByRow) {
        if (REVISION_FIXES.has(verdict.suggestedFix)) {
          revisionNotes.set(row, `${verdict.suggestedFix}: ${verdict.notes}`);
        }
      }
      if (revisionNotes.size > 0) {
        await fineCutSurvivors(
          rows,
          grid,
          shotTimesMs,
          transcript.data.words,
          revisionNotes
        );
      }
      rows = dedupeAndRankMomentRows(rows, chunks);

      const meteredUsage = summarizeStructuredUsages(capturedUsage).filter(
        (usage) =>
          usage.task !== "episode-brief.compose" || ensured.usage === null
      );

      await withOrgScope(payload.organizationId, async (tx) => {
        // A reaper may have retired this attempt while a provider call was in
        // flight. Lock and verify the exact claim before any replacement rows,
        // context snapshot, or metering can be committed.
        const activeAttempt = await assertActiveAttempt(tx, claimed);
        const [snapshot] = await tx
          .insert(contextSnapshot)
          .values({
            content: JSON.parse(canonicalJson(context.pack)),
            hash: hashContextPack(context.pack),
            kind: context.pack.kind,
            organizationId: payload.organizationId,
          })
          .returning({ id: contextSnapshot.id });

        const [replacementFacts] = await tx
          .select({
            boundaryEditCount: sql<number>`count(*) FILTER (WHERE ${momentCandidate.adjustedStartMs} IS NOT NULL OR ${momentCandidate.adjustedEndMs} IS NOT NULL)::int`,
            candidateCount: sql<number>`count(*)::int`,
            decisionCount: sql<number>`count(*) FILTER (WHERE ${momentCandidate.status} <> 'proposed')::int`,
          })
          .from(momentCandidate)
          .where(eq(momentCandidate.sourceId, payload.sourceId));

        // Re-runs replace: candidates belong to exactly one run per source.
        // Human work reaches this point only after the action's exact-version
        // destructive confirmation; its decision/boundary metrics remain in
        // the append-only audit trail.
        await tx
          .delete(momentCandidate)
          .where(eq(momentCandidate.sourceId, payload.sourceId));
        const replacedCandidateCount = Number(
          replacementFacts?.candidateCount ?? 0
        );
        if (replacedCandidateCount > 0) {
          await recordAudit(tx, {
            action: "moment_discovery.replaced",
            actorUserId: null,
            entityId: claimed.runId,
            entityType: "moment_discovery_run",
            metadata: {
              discardedBoundaryEditCount: Number(
                replacementFacts?.boundaryEditCount ?? 0
              ),
              discardedCandidateCount: replacedCandidateCount,
              discardedDecisionCount: Number(
                replacementFacts?.decisionCount ?? 0
              ),
              previousEditVersion: activeAttempt.editVersion,
              sourceId: payload.sourceId,
            },
            organizationId: payload.organizationId,
          });
        }
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

        const [finalized] = await tx
          .update(momentDiscoveryRun)
          .set({
            contextSnapshotId: snapshot?.id ?? null,
            counts: {
              dispatchLease: payload.dispatchLease,
              flagged: [...review.verdicts.values()].filter(isFlaggedVerdict)
                .length,
              grounded: rows.filter((row) => row.grounded).length,
              proposed: rows.length,
              reviewed: review.verdicts.size,
              revised: rows.filter((row) => row.flags.includes("revised"))
                .length,
              suppressed: rows.filter((row) => row.suppressed).length,
            },
            editVersion: 0,
            error: null,
            humanEditedAt: null,
            models: Object.fromEntries(
              meteredUsage.map((usage) => [
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
              eq(momentDiscoveryRun.id, claimed.runId),
              eq(momentDiscoveryRun.attempts, claimed.attempt),
              eq(momentDiscoveryRun.status, "processing")
            )
          )
          .returning({ id: momentDiscoveryRun.id });
        if (!finalized) {
          throw new Error(
            "Moment discovery attempt lost its finalization lease"
          );
        }

        // Capture every verified call, including swallowed optional failures,
        // and sum by task so retries/fallbacks cannot disappear from billing.
        await recordStructuredUsages(tx, {
          callsForTask: (task) =>
            capturedUsage.filter((entry) => entry.task === task).length,
          correlationForTask: (task) =>
            discoveryUsageCorrelation(payload.sourceId, claimed.attempt, task),
          organizationId: payload.organizationId,
          sourceHours: context.durationSeconds / 3600,
          sourceId: payload.sourceId,
          usages: meteredUsage,
        });
      });
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
