import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  fineCutSegmentBoundary,
  isSegmentBoundaryRefinable,
} from "@/lib/ai/capabilities/clip-fine-cut";
import {
  briefToPromptText,
  type EpisodeBrief,
  runSegmentReconcilePass,
  validateClipProposalMode,
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
  type PublisherDraftDossier,
  type PublisherReviewEvidence,
  runSegmentPublisherEdit,
  runSegmentPublisherVerify,
  type SegmentPublisherEdit,
  type SegmentPublisherVerification,
  validateSegmentPublisherVerification,
} from "@/lib/ai/capabilities/segment-publisher";
import { modelFamilyFor } from "@/lib/ai/config";
import {
  canonicalJson,
  hashContextPack,
  type SourceContextPack,
} from "@/lib/ai/context";
import {
  AiBudgetExceededError,
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
import { SEGMENT_PLAN_ARCHITECTURE_VERSION } from "./segment-architecture";
import { applySegmentCutProposals } from "./segment-cuts";
import {
  compilePublisherPlan,
  numberPublisherDraftSegments,
  type PublisherPlanCompileResult,
  type PublisherPlanOperation,
  validatePublisherKeepCoverage,
} from "./segment-publisher";
import {
  applySegmentGrouping,
  numberSegmentAtoms,
  type SegmentGrouping,
} from "./segment-reconcile";
import { terminalSegmentFailureStatus } from "./segment-state";
import { buildSegmentRows, checkPartition, type SegmentRow } from "./segments";

// The S6.5 segment-plan workflow, the discover-pipeline clone one lane
// over: claim → context + rough partition → coarse reconciliation → Cutter →
// deterministic draft → cold screen → required whole-plan Publisher Editor →
// deterministic exact-cover compiler → different-family Publisher Verifier →
// at most one bounded editorial revision → atomic persistence. The cold
// per-clip reviewer stays an independent lens, but only the global Publisher
// gate can make a plan ready. NOT chained from any
// job — planning is a human's button (it leads toward spend-gated
// rendering), so the only entries are the action and the rerun action.

const SEGMENT_ERROR_MAX_CHARS = 2000;
const SEGMENT_HEARTBEAT_INTERVAL_MS = 60_000;
const SEGMENT_USAGE_SUFFIXES: Partial<Record<StructuredUsage["task"], string>> =
  {
    "clip-fine.cut": ":cut",
    "episode-brief.compose": ":brief",
    "moment-review.verdict": ":review",
    "segment-plan.partition": "",
    "segment-plan.reconcile": ":reconcile",
    "segment-publisher.edit": ":publisher-edit",
    "segment-publisher.verify": ":publisher-verify",
  };

function segmentUsageCorrelation(
  sourceId: string,
  attempt: number,
  task: StructuredUsage["task"]
): string {
  const suffix = SEGMENT_USAGE_SUFFIXES[task] ?? `:${task}`;
  return `segment:${sourceId}:${attempt}${suffix}`;
}

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
  finalAttempt: boolean,
  capturedUsage: readonly StructuredUsage[]
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown segment-plan failure";
  const safeMessage = sanitizeIngestError(message).slice(
    0,
    SEGMENT_ERROR_MAX_CHARS
  );
  const failedUsages = structuredFailureUsages(error, capturedUsage);
  await withOrgScope(payload.organizationId, async (tx) => {
    const [updated] = await tx
      .update(segmentPlanRun)
      .set({
        error: safeMessage,
        status: finalAttempt ? terminalSegmentFailureStatus : "pending",
      })
      .where(
        and(
          eq(segmentPlanRun.id, claimed.runId),
          eq(segmentPlanRun.attempts, claimed.attempt),
          eq(segmentPlanRun.status, "processing")
        )
      )
      .returning({ id: segmentPlanRun.id, status: segmentPlanRun.status });
    await recordStructuredUsages(tx, {
      correlationForTask: (task) =>
        segmentUsageCorrelation(payload.sourceId, claimed.attempt, task),
      failed: true,
      organizationId: payload.organizationId,
      sourceId: payload.sourceId,
      usages: failedUsages,
    });
    if (updated?.status === "ready") {
      await recordAudit(tx, {
        action: "segment_plan.refresh_failed_preserved",
        actorUserId: null,
        entityId: updated.id,
        entityType: "segment_plan_run",
        metadata: { attempt: claimed.attempt, sourceId: payload.sourceId },
        organizationId: payload.organizationId,
      });
    }
  });
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
  bySignature: Map<string, MomentReviewVerdict>;
  usage: StructuredUsage | null;
  verdicts: Map<number, MomentReviewVerdict>;
}

const EMPTY_REVIEW: ReviewOutcome = {
  bySignature: new Map(),
  usage: null,
  verdicts: new Map(),
};

function reviewSignature(row: SegmentRow): string {
  return canonicalJson({
    endMs: row.endMs,
    hook: row.hook,
    kind: row.kind,
    startMs: row.startMs,
    title: row.title,
  });
}

// Cold reviewer over the KEEP segments — the same agent, same flag, same
// never-a-gate contract as the moments lane.
async function reviewKeeps(
  rows: readonly SegmentRow[],
  words: readonly TranscriptWord[],
  reusable: ReadonlyMap<string, MomentReviewVerdict> = EMPTY_REVIEW.bySignature
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
    const verdicts = new Map<number, MomentReviewVerdict>();
    const bySignature = new Map<string, MomentReviewVerdict>();
    const missing = reviewable.filter(({ index, row }) => {
      const verdict = reusable.get(reviewSignature(row));
      if (!verdict) {
        return true;
      }
      verdicts.set(index, verdict);
      bySignature.set(reviewSignature(row), verdict);
      return false;
    });
    const result = await reviewMoments(
      missing.map(({ index, row }) => ({
        hook: row.hook ?? "",
        id: String(index),
        lane: "chapter" as const,
        spanText: spanText(words, row),
        title: row.title ?? "",
      }))
    );
    for (const [key, verdict] of result.verdicts) {
      const index = Number(key);
      const row = rows[index];
      if (!row) {
        continue;
      }
      verdicts.set(index, verdict);
      bySignature.set(reviewSignature(row), verdict);
    }
    return {
      bySignature,
      usage: sumStructuredUsage(result.usage),
      verdicts,
    };
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

const PUBLISHER_EDGE_WORDS = 24;
const PUBLISHER_SEMANTIC_ATTEMPTS = 2;
const PUBLISHER_WHITESPACE = /\s+/u;

function edgeWords(
  words: readonly TranscriptWord[],
  row: SegmentRow,
  edge: "close" | "open"
): string {
  const tokens = spanText(words, row)
    .split(PUBLISHER_WHITESPACE)
    .filter(Boolean);
  return edge === "open"
    ? tokens.slice(0, PUBLISHER_EDGE_WORDS).join(" ")
    : tokens.slice(Math.max(0, tokens.length - PUBLISHER_EDGE_WORDS)).join(" ");
}

function publisherReviewEvidence(
  verdict: MomentReviewVerdict | undefined
): PublisherReviewEvidence[] {
  if (!verdict) {
    return [];
  }
  const minimum = Math.min(
    verdict.opensCold,
    verdict.resolves,
    verdict.standsAlone,
    verdict.titleTruthful
  );
  let severity: PublisherReviewEvidence["severity"] = "pass";
  if (minimum === 0) {
    severity = "blocker";
  } else if (minimum < 2 || verdict.suggestedFix !== "none") {
    severity = "warning";
  }
  return [
    {
      code: `cold_${verdict.suggestedFix}`,
      note: `opens=${verdict.opensCold}/2 resolves=${verdict.resolves}/2 standalone=${verdict.standsAlone}/2 title=${verdict.titleTruthful}/2. ${verdict.notes}`,
      severity,
    },
  ];
}

function publisherDossier(
  rows: readonly SegmentRow[],
  words: readonly TranscriptWord[],
  grid: CutGrid,
  brief: EpisodeBrief | null,
  review: ReviewOutcome
): PublisherDraftDossier {
  const numbered = numberPublisherDraftSegments(rows, grid);
  if (numbered.issues.length > 0) {
    throw new Error(
      `Publisher draft failed integrity: ${numbered.issues.map((issue) => issue.message).join("; ")}`
    );
  }
  const segments = numbered.segments.map((segment) => ({
    anchorText: segment.anchorText,
    closesOn: edgeWords(words, segment, "close"),
    dropReason: segment.dropReason,
    durationMs: Math.max(0, segment.endMs - segment.startMs),
    endSentenceId: segment.endSentenceId,
    hook: segment.hook,
    id: segment.id,
    kind: segment.kind,
    opensOn: edgeWords(words, segment, "open"),
    reviewEvidence: publisherReviewEvidence(
      review.bySignature.get(reviewSignature(segment))
    ),
    startSentenceId: segment.startSentenceId,
    summary: segment.summary,
    title: segment.title,
  }));
  const boundaries = segments.slice(1).map((right, index) => {
    const left = segments[index];
    if (!left) {
      throw new Error("Publisher boundary is missing its left segment");
    }
    return {
      afterText: right.opensOn,
      beforeText: left.closesOn,
      id: `B${String(index + 1).padStart(3, "0")}`,
      leftSegmentId: left.id,
      rightSegmentId: right.id,
    };
  });
  const coverage = publisherCoverage(brief, grid);
  return {
    boundaries,
    brief: brief ? briefToPromptText(brief) : null,
    coverage,
    editorialFlags: numbered.segments.flatMap((segment) =>
      segment.flags.map((flag) => `${segment.id}:${flag}`)
    ),
    segments,
    tableOfContents: finalTableOfContents(rows),
  };
}

function publisherCoverage(
  brief: EpisodeBrief | null,
  grid: CutGrid
): PublisherDraftDossier["coverage"] {
  return (brief?.marqueeArcs ?? []).flatMap((arc, index) => {
    const start = grid.paragraphs.find(
      (paragraph) => paragraph.id === arc.startP
    );
    const end = grid.paragraphs.find((paragraph) => paragraph.id === arc.endP);
    if (!(start && end) || start.startSentence > end.endSentence) {
      throw new Error(
        `Publisher coverage ${arc.title} references an invalid paragraph range`
      );
    }
    return [
      {
        endSentenceId: end.endSentence,
        id: `ARC${String(index).padStart(3, "0")}`,
        label: arc.title,
        note: arc.note,
        startSentenceId: start.startSentence,
      },
    ];
  });
}

function publisherCompileIssues(
  compiled: PublisherPlanCompileResult,
  rows: readonly SegmentRow[],
  words: readonly TranscriptWord[],
  grid: CutGrid,
  brief: EpisodeBrief | null
): string[] {
  const issues = compiled.issues.map(
    (issue) =>
      `[${issue.code}]${issue.sliceIndex === undefined ? "" : ` slice ${issue.sliceIndex}`}: ${issue.message}`
  );
  if (!compiled.ok) {
    return issues;
  }
  const partition = checkPartition(rows, words);
  issues.push(...partition.issues.map((issue) => `[partition] ${issue}`));
  if (rows.length !== compiled.items.length) {
    issues.push(
      `[collapsed_slice] compiled ${compiled.items.length} slices but the deterministic gauntlet produced ${rows.length} rows`
    );
  }
  const numbered = numberPublisherDraftSegments(rows, grid);
  issues.push(
    ...numbered.issues.map((issue) => `[${issue.code}] ${issue.message}`)
  );
  for (const segment of numbered.segments) {
    if (segment.kind === "keep" && !segment.grounded) {
      issues.push(
        `[ungrounded_anchor] ${segment.id} anchorText is not verbatim inside its final span`
      );
    }
  }
  issues.push(
    ...validatePublisherKeepCoverage(
      numbered.segments,
      grid,
      publisherCoverage(brief, grid)
    ).map((issue) => `[${issue.code}] ${issue.message}`)
  );
  return issues;
}

interface CompiledPublisherEdit {
  calls: number;
  compile: PublisherPlanCompileResult;
  dossier: PublisherDraftDossier;
  editorModel: string | null;
  output: SegmentPublisherEdit;
  rows: SegmentRow[];
}

async function compilePublisherEdit({
  brief,
  chunks,
  draftRows,
  grid,
  prefixInput,
  review,
  verifierIssues = null,
  words,
}: {
  brief: EpisodeBrief | null;
  chunks: readonly DedupeChunk[];
  draftRows: readonly SegmentRow[];
  grid: CutGrid;
  prefixInput: Parameters<typeof runSegmentPublisherEdit>[0];
  review: ReviewOutcome;
  verifierIssues?: SegmentPublisherVerification | null;
  words: readonly TranscriptWord[];
}): Promise<CompiledPublisherEdit> {
  const dossier = publisherDossier(draftRows, words, grid, brief, review);
  let previousOutput: SegmentPublisherEdit | null = null;
  let validatorIssues: string[] = [];
  for (let attempt = 0; attempt < PUBLISHER_SEMANTIC_ATTEMPTS; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the second pass is a bounded semantic correction using exact deterministic errors
    const result = await runSegmentPublisherEdit(prefixInput, dossier, {
      previousOutput,
      validatorIssues,
      verifierIssues,
    });
    const compiled = compilePublisherPlan(
      draftRows,
      grid,
      result.output.slices
    );
    const rows = compiled.ok
      ? buildSegmentRows(
          compiled.items,
          words,
          words.at(-1)?.endMs ?? 0,
          chunks
        )
      : [];
    validatorIssues = publisherCompileIssues(
      compiled,
      rows,
      words,
      grid,
      brief
    );
    if (validatorIssues.length === 0) {
      return {
        calls: attempt + 1,
        compile: compiled,
        dossier,
        editorModel: result.usage === null ? null : result.usage.model,
        output: result.output,
        rows,
      };
    }
    previousOutput = result.output;
  }
  throw new Error(
    `Publisher Editor output failed integrity: ${validatorIssues.join("; ")}`
  );
}

interface PublisherVerificationOutcome {
  calls: number;
  output: SegmentPublisherVerification;
  verifierModel: string | null;
}

async function verifyPublisherPlan({
  dossier,
  editorModel,
  prefixInput,
}: {
  dossier: PublisherDraftDossier;
  editorModel: string | null;
  prefixInput: Parameters<typeof runSegmentPublisherVerify>[0];
}): Promise<PublisherVerificationOutcome> {
  const excludeModelFamilies = editorModel ? [modelFamilyFor(editorModel)] : [];
  let previousOutput: SegmentPublisherVerification | null = null;
  let validatorIssues: string[] = [];
  for (let attempt = 0; attempt < PUBLISHER_SEMANTIC_ATTEMPTS; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the second pass repairs verifier coverage/consistency using exact local errors
    const result = await runSegmentPublisherVerify(prefixInput, dossier, {
      excludeModelFamilies,
      previousOutput,
      validatorIssues,
    });
    validatorIssues = validateSegmentPublisherVerification(
      result.output,
      dossier
    );
    if (validatorIssues.length === 0) {
      return {
        calls: attempt + 1,
        output: result.output,
        verifierModel: result.usage === null ? null : result.usage.model,
      };
    }
    previousOutput = result.output;
  }
  throw new Error(
    `Publisher Verifier output failed integrity: ${validatorIssues.join("; ")}`
  );
}

function publisherBlockerCodes(
  verification: SegmentPublisherVerification
): string[] {
  return [
    ...verification.segmentVerdicts.flatMap((verdict) =>
      verdict.verdict === "pass"
        ? []
        : [`segment:${verdict.segmentId}:${verdict.issueCode}`]
    ),
    ...verification.boundaryVerdicts.flatMap((verdict) =>
      verdict.verdict === "pass"
        ? []
        : [`boundary:${verdict.boundaryId}:${verdict.issueCode}`]
    ),
    ...verification.coverageVerdicts.flatMap((coverage) =>
      coverage.verdict === "pass" ? [] : [`coverage:${coverage.coverageId}`]
    ),
  ];
}

function publisherArtifactHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

interface PublisherEditorialIteration {
  editorModel: string | null;
  inputPlanHash: string;
  inputSources: Array<{
    endSentenceId: number;
    id: string;
    kind: "drop" | "keep";
    startSentenceId: number;
    title: string | null;
  }>;
  iteration: number;
  operations: PublisherPlanOperation[];
  outputPlanHash: string;
  revisionReason: string;
  slices: SegmentPublisherEdit["slices"];
}

function publisherEditorialIteration(
  iteration: number,
  compiled: CompiledPublisherEdit
): PublisherEditorialIteration {
  return {
    editorModel: compiled.editorModel,
    inputPlanHash: publisherArtifactHash(compiled.dossier),
    inputSources: compiled.dossier.segments.map((segment) => ({
      endSentenceId: segment.endSentenceId,
      id: segment.id,
      kind: segment.kind,
      startSentenceId: segment.startSentenceId,
      title: segment.title,
    })),
    iteration,
    operations: compiled.compile.operations,
    outputPlanHash: publisherArtifactHash(compiled.output.slices),
    revisionReason: compiled.output.revisionReason,
    slices: compiled.output.slices,
  };
}

interface PublisherWorkflowOutcome {
  editCalls: number;
  finalDossierHash: string;
  iterations: PublisherEditorialIteration[];
  operations: Array<{
    iteration: number;
    operation: PublisherPlanOperation;
  }>;
  review: ReviewOutcome;
  revisionReasons: string[];
  revisionRequested: boolean;
  rows: SegmentRow[];
  verification: SegmentPublisherVerification;
  verificationMap: Pick<
    PublisherDraftDossier,
    "boundaries" | "coverage" | "segments"
  >;
  verifierModels: Array<string | null>;
  verifyCalls: number;
}

async function runPublisherWorkflow({
  brief,
  chunks,
  draftRows,
  grid,
  prefixInput,
  words,
}: {
  brief: EpisodeBrief | null;
  chunks: readonly DedupeChunk[];
  draftRows: readonly SegmentRow[];
  grid: CutGrid;
  prefixInput: Parameters<typeof runSegmentPublisherEdit>[0];
  words: readonly TranscriptWord[];
}): Promise<PublisherWorkflowOutcome> {
  const draftReview = await reviewKeeps(draftRows, words);
  const initial = await compilePublisherEdit({
    brief,
    chunks,
    draftRows,
    grid,
    prefixInput,
    review: draftReview,
    words,
  });
  let current = initial;
  let review = await reviewKeeps(current.rows, words, draftReview.bySignature);
  let dossier = publisherDossier(current.rows, words, grid, brief, review);
  let verified = await verifyPublisherPlan({
    dossier,
    editorModel: current.editorModel,
    prefixInput,
  });
  const operations = current.compile.operations.map((operation) => ({
    iteration: 0,
    operation,
  }));
  const iterations = [publisherEditorialIteration(0, current)];
  const verifierModels = [verified.verifierModel];
  const revisionReasons = [current.output.revisionReason];
  let editCalls = current.calls;
  let verifyCalls = verified.calls;
  let revisionRequested = false;

  if (!verified.output.publishable) {
    revisionRequested = true;
    const revision = await compilePublisherEdit({
      brief,
      chunks,
      draftRows: current.rows,
      grid,
      prefixInput,
      review,
      verifierIssues: verified.output,
      words,
    });
    current = revision;
    iterations.push(publisherEditorialIteration(1, revision));
    operations.push(
      ...revision.compile.operations.map((operation) => ({
        iteration: 1,
        operation,
      }))
    );
    revisionReasons.push(revision.output.revisionReason);
    editCalls += revision.calls;
    review = await reviewKeeps(current.rows, words, review.bySignature);
    dossier = publisherDossier(current.rows, words, grid, brief, review);
    verified = await verifyPublisherPlan({
      dossier,
      editorModel: current.editorModel,
      prefixInput,
    });
    verifierModels.push(verified.verifierModel);
    verifyCalls += verified.calls;
  }

  if (!verified.output.publishable) {
    throw new Error(
      `Publisher Verifier blocked the final plan: ${publisherBlockerCodes(verified.output).join(", ") || "unspecified editorial defect"}`
    );
  }
  return {
    editCalls,
    finalDossierHash: publisherArtifactHash(dossier),
    iterations,
    operations,
    review,
    revisionReasons,
    revisionRequested,
    rows: current.rows,
    verification: verified.output,
    verificationMap: {
      boundaries: dossier.boundaries,
      coverage: dossier.coverage,
      segments: dossier.segments,
    },
    verifierModels,
    verifyCalls,
  };
}

async function writeStage(
  payload: SegmentPlanPayload,
  claimed: ClaimedRun,
  stage: string
): Promise<void> {
  const active = await withOrgScope(payload.organizationId, async (tx) => {
    const [updated] = await tx
      .update(segmentPlanRun)
      .set({
        counts: sql`(
          COALESCE(${segmentPlanRun.counts}, '{}'::jsonb)
          - 'dispatchState' - 'dispatchId' - 'dispatchedAt'
        ) || jsonb_build_object(
          'dispatchLease', ${payload.dispatchLease}::text,
          'stage', ${stage}::text
        )`,
      })
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
    usage: sumStructuredUsage(usages),
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
      const validated = validateClipProposalMode(
        run.output,
        "segment_reconcile"
      );
      if (!validated.proposal) {
        validationIssues = validated.issues;
        previousGroups = [];
        continue;
      }
      previousGroups = validated.proposal.reconciliation?.groups ?? [];
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
          usage: sumStructuredUsage(usages),
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
    usage: sumStructuredUsage(usages),
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
  const capturedUsage: StructuredUsage[] = [];

  try {
    await captureStructuredUsage(capturedUsage, async () => {
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
        {
          ...payload,
          usageCorrelationId: `segment:${payload.sourceId}:${claimed.attempt}:brief`,
        },
        prefixInput,
        transcript.revision
      );
      if (!ensured.brief) {
        throw new Error(
          "Segment planning requires a valid episode brief from the Director"
        );
      }

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
      const draftRows = buildSegmentRows(
        refinement.items,
        transcript.data.words,
        durationMs,
        chunks
      );
      const partition = checkPartition(draftRows, transcript.data.words);
      if (!partition.ok) {
        throw new Error(
          `Segment partition failed integrity: ${partition.issues.join("; ")}`
        );
      }
      await writeStage(payload, claimed, "publisher");
      const publisher = await runPublisherWorkflow({
        brief: ensured.brief,
        chunks,
        draftRows,
        grid,
        prefixInput,
        words: transcript.data.words,
      });
      const { review, rows } = publisher;
      const meteredUsage = summarizeStructuredUsages(capturedUsage).filter(
        (usage) =>
          usage.task !== "episode-brief.compose" || ensured.usage === null
      );

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

        await recordAudit(tx, {
          action: "segment_plan.publisher_review_applied",
          actorUserId: null,
          entityId: claimed.runId,
          entityType: "segment_plan_run",
          metadata: {
            attempt: claimed.attempt,
            editCalls: publisher.editCalls,
            finalDossierHash: publisher.finalDossierHash,
            finalVerification: publisher.verification,
            finalVerificationMap: publisher.verificationMap,
            iterations: publisher.iterations,
            operations: publisher.operations,
            revisionReasons: publisher.revisionReasons,
            revisionRequested: publisher.revisionRequested,
            sourceId: payload.sourceId,
            verifierModels: publisher.verifierModels,
            verifyCalls: publisher.verifyCalls,
          },
          organizationId: payload.organizationId,
        });

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
              prePublisherToc: finalTableOfContents(draftRows),
              publisherEditCalls: publisher.editCalls,
              publisherOperationCount: publisher.operations.length,
              publisherOperations: Object.fromEntries(
                [
                  "merge",
                  "move_boundary",
                  "repackage",
                  "set_disposition",
                  "split",
                ].map((type) => [
                  type,
                  publisher.operations.filter(
                    ({ operation }) => operation.type === type
                  ).length,
                ])
              ),
              publisherRevisionRequested: publisher.revisionRequested,
              publisherStatus: "passed",
              publisherVerifyCalls: publisher.verifyCalls,
              publisherWarnings: [
                ...publisher.verification.segmentVerdicts,
                ...publisher.verification.boundaryVerdicts,
                ...publisher.verification.coverageVerdicts,
              ].filter((verdict) => verdict.verdict === "warning").length,
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
              eq(segmentPlanRun.id, claimed.runId),
              eq(segmentPlanRun.attempts, claimed.attempt),
              eq(segmentPlanRun.status, "processing")
            )
          )
          .returning({ id: segmentPlanRun.id });
        if (!finalized) {
          throw new Error("Segment plan attempt lost its finalization lease");
        }

        // Capture every verified call, including swallowed optional failures,
        // and sum by task so retries/fallbacks cannot disappear from billing.
        await recordStructuredUsages(tx, {
          callsForTask: (task) =>
            capturedUsage.filter((entry) => entry.task === task).length,
          correlationForTask: (task) =>
            segmentUsageCorrelation(payload.sourceId, claimed.attempt, task),
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
      // A blown AI budget is terminal regardless of Trigger's retry
      // schedule: each retry starts a fresh budget scope, so parking the
      // run back in "pending" would multiply the ceiling by the attempt
      // count instead of enforcing it.
      (options.finalAttempt ?? true) || error instanceof AiBudgetExceededError,
      capturedUsage
    );
    throw error;
  } finally {
    await stopHeartbeat();
  }
}
