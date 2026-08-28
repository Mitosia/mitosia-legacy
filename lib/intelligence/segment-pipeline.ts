import { and, eq, sql } from "drizzle-orm";
import {
  fineCutSegmentBoundary,
  isSegmentBoundaryRefinable,
} from "@/lib/ai/capabilities/clip-fine-cut";
import {
  type EpisodeBrief,
  runSegmentReconcilePass,
} from "@/lib/ai/capabilities/episode-clips";
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
import { type OrgTransaction, withOrgScope } from "@/lib/db/tenant";
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
import { alignExtraction, tokenizeWords } from "./grounding";
import { type DedupeChunk, spanText } from "./moments";
import { applySegmentCutProposals } from "./segment-cuts";
import {
  applySegmentGrouping,
  numberSegmentAtoms,
  SEGMENT_PLAN_ARCHITECTURE_VERSION,
  type SegmentGrouping,
} from "./segment-reconcile";
import { buildSegmentRows, checkPartition, type SegmentRow } from "./segments";

// The S6.5 segment-plan workflow, the discover-pipeline clone one lane
// over: claim → assemble context + inventories → ONE partition pass →
// global chapter reconciliation → deterministic tiling gauntlet
// (lib/intelligence/segments.ts) → cold reviewer over the keeps → persist
// rows + metering. NOT chained from any
// job — planning is a human's button (it leads toward spend-gated
// rendering), so the only entries are the action and the rerun action.

const SEGMENT_ERROR_MAX_CHARS = 2000;
const SEGMENT_HEARTBEAT_INTERVAL_MS = 60_000;

export interface SegmentPlanPayload {
  dispatchLease: string;
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
          counts: { dispatchLease: payload.dispatchLease },
          organizationId: payload.organizationId,
          sourceId: payload.sourceId,
          status: "processing",
        })
        .onConflictDoNothing({ target: segmentPlanRun.sourceId })
        .returning({ id: segmentPlanRun.id });
      return created ? { attempt: 1, runId: created.id } : null;
    }
    // Only an explicitly queued run is claimable. A failed run requires the
    // human action to transition it back to pending; accepting a late
    // duplicate task directly from failed would resurrect a retired attempt.
    if (existing.status !== "pending") {
      return null;
    }
    const [claimed] = await tx
      .update(segmentPlanRun)
      .set({
        attempts: existing.attempts + 1,
        error: null,
        status: "processing",
      })
      .where(
        and(
          eq(segmentPlanRun.id, existing.id),
          eq(segmentPlanRun.attempts, existing.attempts),
          sql`${segmentPlanRun.counts}->>'dispatchLease' = ${payload.dispatchLease}`,
          eq(segmentPlanRun.status, existing.status)
        )
      )
      .returning({ id: segmentPlanRun.id });
    return claimed
      ? { attempt: existing.attempts + 1, runId: existing.id }
      : null;
  });
}

// finalAttempt=false parks the row back in "pending" between Trigger
// attempts (the #85 contract — see extract-pipeline.ts).
async function recordRunFailure(
  payload: SegmentPlanPayload,
  claimed: ClaimedRun,
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
      .where(
        and(
          eq(segmentPlanRun.id, claimed.runId),
          eq(segmentPlanRun.attempts, claimed.attempt),
          eq(segmentPlanRun.status, "processing")
        )
      )
  );
}

async function heartbeatSegmentRun(
  payload: SegmentPlanPayload,
  claimed: ClaimedRun
): Promise<boolean> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [touched] = await tx
      .update(segmentPlanRun)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(segmentPlanRun.id, claimed.runId),
          eq(segmentPlanRun.attempts, claimed.attempt),
          eq(segmentPlanRun.status, "processing")
        )
      )
      .returning({ id: segmentPlanRun.id });
    return Boolean(touched);
  });
}

function startSegmentRunHeartbeat(
  payload: SegmentPlanPayload,
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
      inFlight = heartbeatSegmentRun(payload, claimed)
        .then((active) => {
          if (!active) {
            stopped = true;
          }
        })
        .catch((error) => {
          console.error(
            `[segments] heartbeat failed for run ${claimed.runId}:`,
            error
          );
        })
        .finally(() => {
          inFlight = null;
          schedule();
        });
    }, SEGMENT_HEARTBEAT_INTERVAL_MS);
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
): Promise<void> {
  await tx.execute(
    sql`SELECT ${segmentPlanRun.id} FROM ${segmentPlanRun} WHERE ${segmentPlanRun.id} = ${claimed.runId} FOR UPDATE`
  );
  const [active] = await tx
    .select({ id: segmentPlanRun.id })
    .from(segmentPlanRun)
    .where(
      and(
        eq(segmentPlanRun.id, claimed.runId),
        eq(segmentPlanRun.attempts, claimed.attempt),
        eq(segmentPlanRun.status, "processing")
      )
    )
    .limit(1);
  if (!active) {
    throw new Error("Segment plan attempt is no longer active");
  }
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

    // Grounded, unsuppressed moments are coverage evidence only. They may
    // sit inside chapters, but never seed a chapter boundary or target count.
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

function finalTableOfContents(rows: readonly SegmentRow[]): string[] {
  let chapter = 0;
  return rows
    .filter((row) => row.kind === "keep")
    .map((row) => {
      chapter += 1;
      return row.title?.trim() || `Untitled chapter ${chapter}`;
    });
}

async function writeStage(
  payload: SegmentPlanPayload,
  claimed: ClaimedRun,
  stage: string
): Promise<void> {
  const active = await withOrgScope(payload.organizationId, async (tx) => {
    const [updated] = await tx
      .update(segmentPlanRun)
      .set({ counts: { dispatchLease: payload.dispatchLease, stage } })
      .where(
        and(
          eq(segmentPlanRun.id, claimed.runId),
          eq(segmentPlanRun.attempts, claimed.attempt),
          eq(segmentPlanRun.status, "processing")
        )
      )
      .returning({ id: segmentPlanRun.id });
    return Boolean(updated);
  });
  if (!active) {
    throw new Error("Segment plan attempt is no longer active");
  }
}

const SEGMENT_CUT_MARGIN_MS = 60_000;
const RECONCILE_VALIDATION_ATTEMPTS = 2;

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
interface SegmentRefinementOutcome {
  applied: number;
  atomicFallback: boolean;
  calls: number;
  items: RawSegmentItem[];
  rejected: number;
  usage: StructuredUsage | null;
}

async function refineSegmentCuts(
  items: readonly RawSegmentItem[],
  grid: CutGrid,
  shotTimesMs: readonly number[],
  firstWord: TranscriptWord | undefined
): Promise<SegmentRefinementOutcome> {
  const firstWordMs = firstWord ? firstWord.startMs : 0;
  const sorted = [...items]
    .sort((a, b) => a.startMs - b.startMs)
    .map((item) => ({ ...item }));
  const targets = sorted
    .map((item, index) => ({ index, item }))
    .filter(({ index, item }) => {
      if (!(index > 0 || item.startMs > firstWordMs)) {
        return false;
      }
      return isSegmentBoundaryRefinable(
        sorted[index - 1]?.kind ?? null,
        item.kind
      );
    });
  if (targets.length === 0) {
    return {
      applied: 0,
      atomicFallback: false,
      calls: 0,
      items: sorted,
      rejected: 0,
      usage: null,
    };
  }
  const usages: StructuredUsage[] = [];
  const proposals: {
    cutId: number;
    itemIndex: number;
    window: ReturnType<typeof cutterWindow>;
  }[] = [];
  await mapWithConcurrency(targets, FINE_CUT_CONCURRENCY, async (target) => {
    try {
      const window = cutterWindow(
        grid,
        { endMs: target.item.startMs, startMs: target.item.startMs },
        SEGMENT_CUT_MARGIN_MS
      );
      const before = sorted[target.index - 1];
      const outcome = await fineCutSegmentBoundary({
        afterDropReason: target.item.dropReason,
        afterKind: target.item.kind,
        afterTitle: boundaryTitle(target.item),
        beforeDropReason: before?.dropReason ?? null,
        beforeKind: before?.kind ?? null,
        beforeTitle: boundaryTitle(before),
        grid,
        roughCutMs: target.item.startMs,
        shotTimesMs,
        window,
      });
      if (outcome.usage) {
        usages.push(outcome.usage);
      }
      proposals.push({
        cutId: outcome.cut.cutId,
        itemIndex: target.index,
        window,
      });
    } catch (error) {
      console.error(
        `[segments] cut refinement failed near ${target.item.startMs}ms:`,
        error
      );
    }
  });
  const applied = applySegmentCutProposals(sorted, grid, proposals);
  return {
    applied: applied.applied,
    atomicFallback: applied.atomicFallback,
    calls: targets.length,
    items: applied.items,
    rejected: applied.rejected + (targets.length - proposals.length),
    usage: sumUsage(usages),
  };
}

interface SegmentReconcileOutcome {
  calls: number;
  issues: string[];
  items: RawSegmentItem[];
  mergedBoundaries: number;
  status: "applied" | "fallback" | "skipped";
  tableOfContents: string[];
  usage: StructuredUsage | null;
}

function identityGroups(
  atoms: ReturnType<typeof numberSegmentAtoms>
): SegmentGrouping[] {
  return atoms.map((atom) => ({
    atomIds: [atom.atomId],
    dropReason: atom.dropReason,
    hook: atom.hook,
    kind: atom.kind,
    reasoning: "This rough atom remains an independent span.",
    summary: atom.summary,
    title: atom.title,
  }));
}

function groundedReconcileAtomIds(
  atoms: ReturnType<typeof numberSegmentAtoms>,
  words: readonly TranscriptWord[]
): Set<string> {
  const tokens = tokenizeWords(words);
  const grounded = new Set<string>();
  for (const atom of atoms) {
    if (atom.kind !== "keep" || !atom.anchorText) {
      continue;
    }
    const aligned = alignExtraction(
      atom.anchorText,
      atom.startMs,
      atom.endMs,
      tokens
    );
    if (
      aligned.grounded &&
      aligned.startMs >= atom.startMs &&
      aligned.endMs <= atom.endMs
    ) {
      grounded.add(atom.atomId);
    }
  }
  return grounded;
}

async function reconcileSegmentPlan(
  items: readonly RawSegmentItem[],
  draftToc: readonly string[],
  prefixInput: Parameters<typeof runSegmentReconcilePass>[0],
  brief: EpisodeBrief | null,
  words: readonly TranscriptWord[]
): Promise<SegmentReconcileOutcome> {
  const atoms = numberSegmentAtoms(items);
  const groundedAtomIds = groundedReconcileAtomIds(atoms, words);
  const groupingContext = { groundedAtomIds };
  const identity = applySegmentGrouping(
    atoms,
    identityGroups(atoms),
    groupingContext
  );
  const hasMergeCandidate = atoms.some(
    (atom, index) => atom.kind === "keep" && atoms[index + 1]?.kind === "keep"
  );
  if (
    atoms.length < 2 ||
    !hasMergeCandidate ||
    process.env.ANALYSIS_PROVIDER === "mock"
  ) {
    return {
      calls: 0,
      issues: identity.issues,
      items: identity.items,
      mergedBoundaries: 0,
      status: identity.status === "fallback" ? "fallback" : "skipped",
      tableOfContents: identity.tableOfContents,
      usage: null,
    };
  }

  const usages: StructuredUsage[] = [];
  let validationIssues: string[] = [];
  let previousGroups: SegmentGrouping[] = [];
  try {
    for (
      let attempt = 0;
      attempt < RECONCILE_VALIDATION_ATTEMPTS;
      attempt += 1
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: second call is a bounded semantic-contract repair using the first call's exact validator errors
      const run = await runSegmentReconcilePass(
        prefixInput,
        brief,
        draftToc,
        atoms.map((atom) => ({
          ...atom,
          anchorText: groundedAtomIds.has(atom.atomId) ? atom.anchorText : null,
        })),
        validationIssues,
        previousGroups
      );
      usages.push(run.usage);
      previousGroups = run.output.reconciliation?.groups ?? [];
      const applied = applySegmentGrouping(
        atoms,
        previousGroups,
        groupingContext
      );
      if (applied.status === "applied") {
        return {
          calls: attempt + 1,
          issues: [],
          items: applied.items,
          mergedBoundaries: applied.mergedBoundaries,
          status: "applied",
          tableOfContents: applied.tableOfContents,
          usage: sumUsage(usages),
        };
      }
      validationIssues = applied.issues;
    }
  } catch (error) {
    console.error("[segments] chapter reconciliation failed:", error);
    validationIssues = [
      sanitizeIngestError(
        error instanceof Error
          ? error.message
          : "Unknown reconciliation failure"
      ).slice(0, 500),
    ];
  }
  return {
    calls: usages.length,
    issues: validationIssues,
    items: identity.items,
    mergedBoundaries: 0,
    status: "fallback",
    tableOfContents: identity.tableOfContents,
    usage: sumUsage(usages),
  };
}

export async function runSegmentPlanPipeline(
  payload: SegmentPlanPayload,
  options: { finalAttempt?: boolean } = {}
): Promise<void> {
  const claimed = await claimRun(payload);
  if (!claimed) {
    return;
  }
  const stopHeartbeat = startSegmentRunHeartbeat(payload, claimed);

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
    // rough partition → global boundary reconciliation → per-cut refinement
    // seeing both sides → tiling gauntlet → cold review. Planning stays a
    // button; the brief row is
    // the cross-run memory when the prompt cache has gone cold.
    const grid = buildCutGrid(transcript.data.words);
    const shotTimesMs = await loadShotTimes(payload);
    const prefixInput = clipPrefixInput(
      {
        analysis: context.input.analysis,
        contextPack: context.input.contextPack,
        seeds: context.input.seeds,
      },
      grid
    );

    await writeStage(payload, claimed, "brief");
    const ensured = await ensureEpisodeBrief(
      payload,
      prefixInput,
      transcript.revision
    );

    await writeStage(payload, claimed, "rough");
    const result = await runSegmentPlan(
      {
        ...context.input,
        durationMs,
        transcript: transcript.data,
      },
      { brief: ensured.brief }
    );

    await writeStage(payload, claimed, "reconcile");
    const reconciliation = await reconcileSegmentPlan(
      result.items,
      result.tableOfContents,
      prefixInput,
      ensured.brief,
      transcript.data.words
    );

    await writeStage(payload, claimed, "cut");
    const refinement = await refineSegmentCuts(
      reconciliation.items,
      grid,
      shotTimesMs,
      transcript.data.words[0]
    );

    const chunks = await loadDedupeChunks(payload);
    const rows = buildSegmentRows(
      refinement.items,
      transcript.data.words,
      durationMs,
      chunks
    );
    const partition = checkPartition(rows, transcript.data.words);
    if (!partition.ok) {
      throw new Error(
        `Segment partition failed integrity: ${partition.issues.join("; ")}`
      );
    }
    await writeStage(payload, claimed, "review");
    const review = await reviewKeeps(rows, transcript.data.words);

    await withOrgScope(payload.organizationId, async (tx) => {
      // The reaper may have retired a silent attempt while a provider call
      // was still in flight. Lock and verify the exact claim before any
      // replacement rows or metering are written, so an old worker cannot
      // resurrect itself over a retry.
      await assertActiveAttempt(tx, claimed);
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

      const [finalized] = await tx
        .update(segmentPlanRun)
        .set({
          contextSnapshotId: snapshot?.id ?? null,
          counts: {
            architectureVersion: SEGMENT_PLAN_ARCHITECTURE_VERSION,
            dispatchLease: payload.dispatchLease,
            draftToc: result.tableOfContents,
            dropped: rows.filter((row) => row.kind === "drop").length,
            flagged: [...review.verdicts.values()].filter(isFlaggedVerdict)
              .length,
            grounded: rows.filter((row) => row.grounded).length,
            kept: rows.filter((row) => row.kind === "keep").length,
            mergedBoundaries: reconciliation.mergedBoundaries,
            reconcileCalls: reconciliation.calls,
            reconciledToc: reconciliation.tableOfContents,
            reconcileIssues: reconciliation.issues,
            reconcileStatus: reconciliation.status,
            refinedApplied: refinement.applied,
            refinedAtomicFallback: refinement.atomicFallback,
            refinedCuts: refinement.calls,
            refinedRejected: refinement.rejected,
            reviewed: review.verdicts.size,
            roughKept: result.items.filter((item) => item.kind === "keep")
              .length,
            roughSegments: result.items.length,
            segments: rows.length,
            toc: finalTableOfContents(rows),
          },
          editVersion: 0,
          error: null,
          humanEditedAt: null,
          models: Object.fromEntries(
            [...result.usage, reconciliation.usage]
              .filter((usage): usage is StructuredUsage => usage !== null)
              .map((usage) => [
                usage.task,
                { model: usage.model, provider: usage.provider },
              ])
          ),
          revision: transcript.revision,
          status: "ready",
        })
        .where(
          and(
            eq(segmentPlanRun.id, claimed.runId),
            eq(segmentPlanRun.attempts, claimed.attempt),
            eq(segmentPlanRun.status, "processing")
          )
        )
        .returning({ id: segmentPlanRun.id });
      if (!finalized) {
        throw new Error("Segment plan attempt lost its finalization lease");
      }

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
        [
          `segment:${payload.sourceId}:${claimed.attempt}:reconcile`,
          reconciliation.usage,
          reconciliation.calls,
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

      const roughUsage = sumUsage(result.usage);
      if (roughUsage) {
        await recordUsage(tx, {
          correlationId: `segment:${payload.sourceId}:${claimed.attempt}`,
          entryType: "ai_tokens",
          metadata: {
            calls: result.usage.length,
            costUsd: roughUsage.costUsd,
            inputTokens: roughUsage.inputTokens,
            model: roughUsage.model,
            outputTokens: roughUsage.outputTokens,
            provider: roughUsage.provider,
            sourceHours: context.durationSeconds / 3600,
            task: roughUsage.task,
          },
          organizationId: payload.organizationId,
          quantity: roughUsage.inputTokens + roughUsage.outputTokens,
          sourceId: payload.sourceId,
          unit: "tokens",
        });
      }
    });
  } catch (error) {
    await recordRunFailure(
      payload,
      claimed,
      error,
      options.finalAttempt ?? true
    );
    throw error;
  } finally {
    await stopHeartbeat();
  }
}
