"use server";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { isFlaggedVerdict } from "@/lib/ai/capabilities/moment-review";
import { recordAudit } from "@/lib/audit";
import { segmentClip, segmentPlanRun, source } from "@/lib/db/schema";
import { type OrgTransaction, withOrgScope } from "@/lib/db/tenant";
import { alignExtraction, tokenizeWords } from "@/lib/intelligence/grounding";
import { sentenceStartTimes } from "@/lib/intelligence/moments";
import {
  dispatchSegmentPlan,
  segmentPlanningConfigured,
} from "@/lib/intelligence/segment-enqueue";
import { requireOrg } from "@/lib/org";
import { loadCurrentTranscript } from "@/lib/transcription/store";

// Review actions for the segment plan (S6.5) — same D5 contract as
// lib/actions/moments.ts: every decision and boundary adjustment is a
// column write PLUS an audit entry in the same transaction; the rows ARE
// the review record.

const REJECT_REASONS = [
  "not_interesting",
  "wrong_boundaries",
  "out_of_context",
  "sensitive",
  "duplicate",
  "other",
] as const;

const RANGE_DERIVED_FLAGS = new Set([
  "long_outlier",
  "no_anchor",
  "short_outlier",
  "ungrounded_after_edit",
]);

const SEGMENT_DISPATCH_ERROR =
  "Segment planning could not be queued. Try again.";

async function lockSegmentPlan(
  tx: OrgTransaction,
  runId: string
): Promise<{ editVersion: number; status: string } | null> {
  // Every human mutation takes the same run-level lock. A merge changes
  // row identity and adjacency, so locking only the two rows being edited
  // would still allow a concurrent decision or neighboring nudge to act on
  // a stale partition. Re-read rows only after this lock is acquired.
  await tx.execute(
    sql`SELECT ${segmentPlanRun.id} FROM ${segmentPlanRun} WHERE ${segmentPlanRun.id} = ${runId} FOR UPDATE`
  );
  const [run] = await tx
    .select({
      editVersion: segmentPlanRun.editVersion,
      status: segmentPlanRun.status,
    })
    .from(segmentPlanRun)
    .where(eq(segmentPlanRun.id, runId))
    .limit(1);
  return run ?? null;
}

function recordObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function storedReviewIsFlagged(row: {
  reviewFix: string | null;
  reviewScores: unknown;
}): boolean {
  const scores = recordObject(row.reviewScores);
  const { opensCold, resolves, standsAlone, titleTruthful } = scores;
  if (
    !(
      typeof opensCold === "number" &&
      typeof resolves === "number" &&
      typeof standsAlone === "number" &&
      typeof titleTruthful === "number"
    )
  ) {
    return false;
  }
  return isFlaggedVerdict({
    opensCold,
    resolves,
    standsAlone,
    suggestedFix: row.reviewFix ?? "none",
    titleTruthful,
  });
}

function currentTableOfContents(
  keeps: readonly { title: string | null }[]
): string[] {
  return keeps.map(
    (row, index) => row.title?.trim() || `Untitled chapter ${index + 1}`
  );
}

async function markSegmentPlanEdited(
  tx: OrgTransaction,
  runId: string,
  refreshPlanFacts = false
): Promise<void> {
  let counts: Record<string, unknown> | undefined;
  if (refreshPlanFacts) {
    const [run] = await tx
      .select({ counts: segmentPlanRun.counts })
      .from(segmentPlanRun)
      .where(eq(segmentPlanRun.id, runId))
      .limit(1);
    const rows = await tx
      .select({
        grounded: segmentClip.grounded,
        kind: segmentClip.kind,
        reviewFix: segmentClip.reviewFix,
        reviewScores: segmentClip.reviewScores,
        title: segmentClip.title,
      })
      .from(segmentClip)
      .where(eq(segmentClip.runId, runId))
      .orderBy(segmentClip.idx);
    const keeps = rows.filter((row) => row.kind === "keep");
    counts = {
      ...recordObject(run?.counts),
      dropped: rows.length - keeps.length,
      flagged: keeps.filter(storedReviewIsFlagged).length,
      grounded: rows.filter((row) => row.grounded).length,
      kept: keeps.length,
      reviewed: keeps.filter((row) => row.reviewScores !== null).length,
      segments: rows.length,
      toc: currentTableOfContents(keeps),
    };
  }
  await tx
    .update(segmentPlanRun)
    .set({
      ...(counts ? { counts } : {}),
      editVersion: sql`${segmentPlanRun.editVersion} + 1`,
      humanEditedAt: new Date(),
    })
    .where(eq(segmentPlanRun.id, runId));
}

function groundingAfterRangeEdit(
  row: {
    anchorText: string | null;
    flags: unknown;
    kind: "drop" | "keep";
  },
  startMs: number,
  endMs: number,
  tokens: ReturnType<typeof tokenizeWords>
): { flags: string[]; grounded: boolean; groundingScore: number } {
  const flags = new Set(
    (Array.isArray(row.flags) ? (row.flags as string[]) : []).filter(
      (flag) => !RANGE_DERIVED_FLAGS.has(flag)
    )
  );
  if (row.kind === "drop") {
    return { flags: [...flags], grounded: true, groundingScore: 1 };
  }
  if (!row.anchorText) {
    flags.add("no_anchor");
    return { flags: [...flags], grounded: false, groundingScore: 0 };
  }
  const aligned = alignExtraction(row.anchorText, startMs, endMs, tokens);
  const grounded =
    aligned.grounded && aligned.startMs >= startMs && aligned.endMs <= endMs;
  if (!grounded) {
    flags.add("ungrounded_after_edit");
  }
  return {
    flags: [...flags],
    grounded,
    groundingScore: aligned.score,
  };
}

// Planning is a human's button, never a chain: the plan heads toward
// spend-gated rendering, so the strategist chooses when. First click
// creates the run; re-plans refuse while decisions exist (below).
export interface SegmentPlanActionState extends ActionState {
  protectedEditVersion?: number;
  protectedRunId?: string;
}

interface PlanTransitionRequest {
  dispatchLease: string;
  expectedEditVersion: number | null;
  expectedRunId: string | null;
  force: boolean;
  organizationId: string;
  sourceId: string;
  userId: string;
}

type PlanTransition =
  | { dispatchLease: string; status: "queued" }
  | { status: "missing" | "running" | "stale-confirmation" }
  | {
      editVersion: number;
      runId: string;
      status: "protected";
    };

async function visibleOrCreatedSegmentRun(
  tx: OrgTransaction,
  request: PlanTransitionRequest
): Promise<{ created: boolean; id: string } | null> {
  const [ownedSource] = await tx
    .select({ id: source.id })
    .from(source)
    .where(eq(source.id, request.sourceId))
    .limit(1);
  if (!ownedSource) {
    return null;
  }
  const [existing] = await tx
    .select({ id: segmentPlanRun.id })
    .from(segmentPlanRun)
    .where(eq(segmentPlanRun.sourceId, request.sourceId))
    .limit(1);
  if (existing) {
    return { created: false, id: existing.id };
  }
  const [created] = await tx
    .insert(segmentPlanRun)
    .values({
      counts: {
        dispatchLease: request.dispatchLease,
        dispatchState: "pending",
      },
      organizationId: request.organizationId,
      sourceId: request.sourceId,
      status: "pending",
    })
    .onConflictDoNothing({ target: segmentPlanRun.sourceId })
    .returning({ id: segmentPlanRun.id });
  if (created) {
    await recordAudit(tx, {
      action: "segment_plan.started",
      actorUserId: request.userId,
      entityId: created.id,
      entityType: "segment_plan_run",
      organizationId: request.organizationId,
    });
    return { created: true, id: created.id };
  }
  const [conflicted] = await tx
    .select({ id: segmentPlanRun.id })
    .from(segmentPlanRun)
    .where(eq(segmentPlanRun.sourceId, request.sourceId))
    .limit(1);
  return conflicted ? { created: false, id: conflicted.id } : null;
}

async function transitionSegmentPlan(
  tx: OrgTransaction,
  request: PlanTransitionRequest
): Promise<PlanTransition> {
  const resolved = await visibleOrCreatedSegmentRun(tx, request);
  if (!resolved) {
    return { status: "missing" };
  }
  if (resolved.created) {
    return { dispatchLease: request.dispatchLease, status: "queued" };
  }
  const locked = await lockSegmentPlan(tx, resolved.id);
  if (!locked) {
    return { status: "missing" };
  }
  if (locked.status === "processing" || locked.status === "pending") {
    return { status: "running" };
  }
  if (
    request.force &&
    (request.expectedRunId !== resolved.id ||
      request.expectedEditVersion !== locked.editVersion)
  ) {
    return { status: "stale-confirmation" };
  }
  const [decided] = await tx
    .select({ id: segmentClip.id })
    .from(segmentClip)
    .where(
      and(
        eq(segmentClip.sourceId, request.sourceId),
        ne(segmentClip.status, "proposed")
      )
    )
    .limit(1);
  if ((decided || locked.editVersion > 0) && !request.force) {
    return {
      editVersion: locked.editVersion,
      runId: resolved.id,
      status: "protected",
    };
  }
  await tx
    .update(segmentPlanRun)
    .set({
      counts: {
        dispatchLease: request.dispatchLease,
        dispatchState: "pending",
      },
      error: null,
      status: "pending",
    })
    .where(eq(segmentPlanRun.id, resolved.id));
  await recordAudit(tx, {
    action: "segment_plan.rerun",
    actorUserId: request.userId,
    entityId: resolved.id,
    entityType: "segment_plan_run",
    metadata: request.force ? { force: true } : undefined,
    organizationId: request.organizationId,
  });
  return { dispatchLease: request.dispatchLease, status: "queued" };
}

export async function planSegmentsAction(
  _state: SegmentPlanActionState,
  formData: FormData
): Promise<SegmentPlanActionState> {
  const parsedId = z.uuid().safeParse(formData.get("sourceId"));
  if (!parsedId.success) {
    return { error: "Invalid source reference." };
  }
  const force = formData.get("force") === "true";
  const parsedExpectedRunId = z.uuid().safeParse(formData.get("expectedRunId"));
  const parsedExpectedEditVersion = z.coerce
    .number()
    .int()
    .nonnegative()
    .safeParse(formData.get("expectedEditVersion"));
  if (
    force &&
    !(parsedExpectedRunId.success && parsedExpectedEditVersion.success)
  ) {
    return { error: "Review the latest plan before discarding its edits." };
  }
  const expectedRunId = parsedExpectedRunId.success
    ? parsedExpectedRunId.data
    : null;
  const expectedEditVersion = parsedExpectedEditVersion.success
    ? parsedExpectedEditVersion.data
    : null;
  const { organizationId, userId } = await requireOrg();
  if (!segmentPlanningConfigured()) {
    return { error: "AI segment planning is not configured." };
  }
  const dispatchLease = randomUUID();

  const transition = await withOrgScope(organizationId, (tx) =>
    transitionSegmentPlan(tx, {
      dispatchLease,
      expectedEditVersion,
      expectedRunId,
      force,
      organizationId,
      sourceId: parsedId.data,
      userId,
    })
  );
  if (transition.status === "running") {
    return { error: "Segment planning is already running." };
  }
  if (transition.status === "protected") {
    return {
      error:
        "This plan has human review or edits. Re-planning would discard them.",
      protectedEditVersion: transition.editVersion,
      protectedRunId: transition.runId,
    };
  }
  if (transition.status === "stale-confirmation") {
    return { error: "The plan changed. Review it again before re-planning." };
  }
  if (transition.status !== "queued") {
    return { error: "Could not start segment planning." };
  }

  try {
    const dispatchId = await dispatchSegmentPlan({
      dispatchLease: transition.dispatchLease,
      organizationId,
      sourceId: parsedId.data,
    });
    await withOrgScope(organizationId, async (tx) => {
      const [confirmed] = await tx
        .update(segmentPlanRun)
        .set({
          counts: {
            dispatchedAt: new Date().toISOString(),
            dispatchId,
            dispatchLease: transition.dispatchLease,
            dispatchState: "confirmed",
          },
        })
        .where(
          and(
            eq(segmentPlanRun.sourceId, parsedId.data),
            sql`${segmentPlanRun.counts}->>'dispatchLease' = ${transition.dispatchLease}`,
            eq(segmentPlanRun.status, "pending")
          )
        )
        .returning({ id: segmentPlanRun.id });
      if (confirmed) {
        await recordAudit(tx, {
          action: "segment_plan.dispatched",
          actorUserId: userId,
          entityId: confirmed.id,
          entityType: "segment_plan_run",
          metadata: { dispatchId },
          organizationId,
        });
      }
    });
  } catch (error) {
    console.error(
      `[segments] could not dispatch source ${parsedId.data}:`,
      error
    );
    await withOrgScope(organizationId, async (tx) => {
      const [failedRun] = await tx
        .update(segmentPlanRun)
        .set({ error: SEGMENT_DISPATCH_ERROR, status: "failed" })
        .where(
          and(
            eq(segmentPlanRun.sourceId, parsedId.data),
            sql`${segmentPlanRun.counts}->>'dispatchLease' = ${transition.dispatchLease}`,
            eq(segmentPlanRun.status, "pending")
          )
        )
        .returning({ id: segmentPlanRun.id });
      if (failedRun) {
        await recordAudit(tx, {
          action: "segment_plan.dispatch_failed",
          actorUserId: userId,
          entityId: failedRun.id,
          entityType: "segment_plan_run",
          organizationId,
        });
      }
    });
    return { error: SEGMENT_DISPATCH_ERROR };
  }

  revalidatePath(`/sources/${parsedId.data}`);
  return { success: true };
}

const decideSchema = z.object({
  decision: z.enum(["accepted", "rejected", "proposed"]),
  rejectNote: z.string().trim().max(500).optional(),
  rejectReason: z.enum(REJECT_REASONS).optional(),
  segmentId: z.uuid(),
});

const METADATA_REQUIRED = "metadata-required" as const;

function hasCompleteSegmentMetadata(row: {
  flags: unknown;
  hook: string | null;
  summary: string | null;
  title: string | null;
}): boolean {
  const flags = Array.isArray(row.flags) ? (row.flags as string[]) : [];
  return (
    !flags.includes("needs_metadata_review") &&
    Boolean(row.title?.trim() && row.hook?.trim() && row.summary?.trim())
  );
}

interface SegmentDecisionRequest extends z.infer<typeof decideSchema> {
  organizationId: string;
  userId: string;
}

async function persistSegmentDecision(
  tx: OrgTransaction,
  request: SegmentDecisionRequest
): Promise<string | typeof METADATA_REQUIRED | null> {
  const [candidate] = await tx
    .select({ runId: segmentClip.runId })
    .from(segmentClip)
    .where(eq(segmentClip.id, request.segmentId))
    .limit(1);
  if (!candidate) {
    return null;
  }
  const run = await lockSegmentPlan(tx, candidate.runId);
  if (run?.status !== "ready") {
    return null;
  }
  const [row] = await tx
    .select({
      flags: segmentClip.flags,
      hook: segmentClip.hook,
      kind: segmentClip.kind,
      runId: segmentClip.runId,
      sourceId: segmentClip.sourceId,
      summary: segmentClip.summary,
      title: segmentClip.title,
    })
    .from(segmentClip)
    .where(eq(segmentClip.id, request.segmentId))
    .limit(1);
  if (!row || row.runId !== candidate.runId || row.kind !== "keep") {
    return null;
  }
  if (request.decision === "accepted" && !hasCompleteSegmentMetadata(row)) {
    return METADATA_REQUIRED;
  }
  const rejected = request.decision === "rejected";
  await tx
    .update(segmentClip)
    .set({
      decidedAt: request.decision === "proposed" ? null : new Date(),
      decidedBy: request.decision === "proposed" ? null : request.userId,
      rejectNote: rejected ? (request.rejectNote ?? null) : null,
      rejectReason: rejected ? (request.rejectReason ?? null) : null,
      status: request.decision,
    })
    .where(eq(segmentClip.id, request.segmentId));
  await markSegmentPlanEdited(tx, row.runId);
  await recordAudit(tx, {
    action: `segment.${request.decision}`,
    actorUserId: request.userId,
    entityId: request.segmentId,
    entityType: "segment_clip",
    metadata: {
      segmentId: request.segmentId,
      ...(rejected ? { reason: request.rejectReason } : {}),
    },
    organizationId: request.organizationId,
  });
  return row.sourceId;
}

export async function decideSegmentAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = decideSchema.safeParse({
    decision: formData.get("decision"),
    rejectNote: formData.get("rejectNote") ?? undefined,
    rejectReason: formData.get("rejectReason") ?? undefined,
    segmentId: formData.get("segmentId"),
  });
  if (!parsed.success) {
    return { error: "Invalid review decision." };
  }
  const { decision, rejectNote, rejectReason, segmentId } = parsed.data;
  if (decision === "rejected" && !rejectReason) {
    return { error: "Pick a reason to reject." };
  }
  const { organizationId, userId } = await requireOrg();

  const sourceId = await withOrgScope(organizationId, (tx) =>
    persistSegmentDecision(tx, {
      decision,
      organizationId,
      rejectNote,
      rejectReason,
      segmentId,
      userId,
    })
  );
  if (sourceId === METADATA_REQUIRED) {
    return { error: "Finish the chapter title, hook, and summary first." };
  }
  if (!sourceId) {
    return { error: "That segment no longer exists." };
  }

  revalidatePath(`/sources/${sourceId}`);
  return { success: true };
}

// A drop the human disagrees with becomes a keep again — proposed, with
// its drop reason cleared. The model's call was a proposal, never a veto.
export async function restoreSegmentAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsedId = z.uuid().safeParse(formData.get("segmentId"));
  if (!parsedId.success) {
    return { error: "Invalid segment reference." };
  }
  const { organizationId, userId } = await requireOrg();

  const sourceId = await withOrgScope(organizationId, async (tx) => {
    const [candidate] = await tx
      .select({ runId: segmentClip.runId })
      .from(segmentClip)
      .where(eq(segmentClip.id, parsedId.data))
      .limit(1);
    if (!candidate) {
      return null;
    }
    const run = await lockSegmentPlan(tx, candidate.runId);
    if (run?.status !== "ready") {
      return null;
    }
    const [row] = await tx
      .select({
        flags: segmentClip.flags,
        kind: segmentClip.kind,
        runId: segmentClip.runId,
        sourceId: segmentClip.sourceId,
      })
      .from(segmentClip)
      .where(eq(segmentClip.id, parsedId.data))
      .limit(1);
    if (row?.kind !== "drop" || row.runId !== candidate.runId) {
      return null;
    }
    await tx
      .update(segmentClip)
      .set({
        anchorText: null,
        decidedAt: null,
        decidedBy: null,
        dropReason: null,
        flags: [
          ...new Set([
            ...(Array.isArray(row.flags) ? (row.flags as string[]) : []),
            "human_restored",
            "needs_metadata_review",
            "no_anchor",
          ]),
        ],
        grounded: false,
        groundingScore: 0,
        kind: "keep",
        rejectNote: null,
        rejectReason: null,
        reviewFix: null,
        reviewNotes: null,
        reviewScores: null,
        status: "proposed",
      })
      .where(eq(segmentClip.id, parsedId.data));
    await markSegmentPlanEdited(tx, row.runId, true);
    await recordAudit(tx, {
      action: "segment.restored",
      actorUserId: userId,
      entityId: parsedId.data,
      entityType: "segment_clip",
      metadata: { segmentId: parsedId.data },
      organizationId,
    });
    return row.sourceId;
  });
  if (!sourceId) {
    return { error: "That segment is not a dropped stretch." };
  }

  revalidatePath(`/sources/${sourceId}`);
  return { success: true };
}

const metadataSchema = z.object({
  hook: z.string().trim().min(1).max(200),
  segmentId: z.uuid(),
  summary: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(120),
});

export async function saveSegmentMetadataAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = metadataSchema.safeParse({
    hook: formData.get("hook"),
    segmentId: formData.get("segmentId"),
    summary: formData.get("summary"),
    title: formData.get("title"),
  });
  if (!parsed.success) {
    return { error: "Add a title, hook, and summary within the limits." };
  }
  const { hook, segmentId, summary, title } = parsed.data;
  const { organizationId, userId } = await requireOrg();

  const sourceId = await withOrgScope(organizationId, async (tx) => {
    const [candidate] = await tx
      .select({ runId: segmentClip.runId })
      .from(segmentClip)
      .where(eq(segmentClip.id, segmentId))
      .limit(1);
    if (!candidate) {
      return null;
    }
    const run = await lockSegmentPlan(tx, candidate.runId);
    if (run?.status !== "ready") {
      return null;
    }
    const [row] = await tx
      .select({
        flags: segmentClip.flags,
        hook: segmentClip.hook,
        kind: segmentClip.kind,
        runId: segmentClip.runId,
        sourceId: segmentClip.sourceId,
        summary: segmentClip.summary,
        title: segmentClip.title,
      })
      .from(segmentClip)
      .where(eq(segmentClip.id, segmentId))
      .limit(1);
    if (!row || row.runId !== candidate.runId || row.kind !== "keep") {
      return null;
    }
    const flags = Array.isArray(row.flags)
      ? (row.flags as string[]).filter(
          (flag) => flag !== "needs_metadata_review"
        )
      : [];
    await tx
      .update(segmentClip)
      .set({
        decidedAt: null,
        decidedBy: null,
        flags,
        hook,
        rejectNote: null,
        rejectReason: null,
        reviewFix: null,
        reviewNotes: null,
        reviewScores: null,
        status: "proposed",
        summary,
        title,
      })
      .where(eq(segmentClip.id, segmentId));
    await markSegmentPlanEdited(tx, row.runId, true);
    await recordAudit(tx, {
      action: "segment.metadata_updated",
      actorUserId: userId,
      entityId: segmentId,
      entityType: "segment_clip",
      metadata: {
        after: { hook, summary, title },
        before: { hook: row.hook, summary: row.summary, title: row.title },
        segmentId,
      },
      organizationId,
    });
    return row.sourceId;
  });
  if (!sourceId) {
    return { error: "That kept chapter no longer exists." };
  }
  revalidatePath(`/sources/${sourceId}`);
  return { success: true };
}

const boundarySchema = z.object({
  boundaryMs: z.coerce.number().int().nonnegative(),
  leftSegmentId: z.uuid(),
  rightSegmentId: z.uuid(),
});

export async function saveSegmentBoundariesAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = boundarySchema.safeParse({
    boundaryMs: formData.get("boundaryMs"),
    leftSegmentId: formData.get("leftSegmentId"),
    rightSegmentId: formData.get("rightSegmentId"),
  });
  if (!parsed.success) {
    return { error: "Invalid boundaries." };
  }
  const { boundaryMs, leftSegmentId, rightSegmentId } = parsed.data;
  const { organizationId, userId } = await requireOrg();

  const boundaryContext = await withOrgScope(organizationId, async (tx) => {
    const candidates = await tx
      .select({
        id: segmentClip.id,
        revision: segmentClip.revision,
        runId: segmentClip.runId,
        sourceId: segmentClip.sourceId,
      })
      .from(segmentClip)
      .where(inArray(segmentClip.id, [leftSegmentId, rightSegmentId]));
    const left = candidates.find((row) => row.id === leftSegmentId);
    const right = candidates.find((row) => row.id === rightSegmentId);
    return left &&
      right &&
      left.sourceId === right.sourceId &&
      left.runId === right.runId &&
      left.revision === right.revision
      ? {
          revision: left.revision,
          runId: left.runId,
          sourceId: left.sourceId,
        }
      : null;
  });
  if (!boundaryContext) {
    return { error: "Those chapters are no longer adjacent." };
  }
  const transcript = await loadCurrentTranscript(
    organizationId,
    boundaryContext.sourceId
  );
  if (
    !transcript ||
    transcript.revision !== boundaryContext.revision ||
    !sentenceStartTimes(transcript.data.words).includes(boundaryMs)
  ) {
    return { error: "Choose a boundary on the current sentence grid." };
  }
  const groundingTokens = tokenizeWords(transcript.data.words);

  const sourceId = await withOrgScope(organizationId, async (tx) => {
    const run = await lockSegmentPlan(tx, boundaryContext.runId);
    if (run?.status !== "ready") {
      return null;
    }
    const rows = await tx
      .select()
      .from(segmentClip)
      .where(eq(segmentClip.runId, boundaryContext.runId))
      .orderBy(segmentClip.idx);
    const left = rows.find((row) => row.id === leftSegmentId);
    const right = rows.find((row) => row.id === rightSegmentId);
    if (
      !(left && right) ||
      left.sourceId !== right.sourceId ||
      left.runId !== right.runId ||
      left.revision !== transcript.revision ||
      right.revision !== transcript.revision
    ) {
      return null;
    }
    const leftPosition = rows.findIndex((row) => row.id === left.id);
    const rightPosition = rows.findIndex((row) => row.id === right.id);
    const leftStart = left.adjustedStartMs ?? left.startMs;
    const rightEnd = right.adjustedEndMs ?? right.endMs;
    if (
      leftPosition < 0 ||
      rightPosition !== leftPosition + 1 ||
      boundaryMs <= leftStart ||
      boundaryMs >= rightEnd
    ) {
      return null;
    }
    const leftGrounding = groundingAfterRangeEdit(
      left,
      leftStart,
      boundaryMs,
      groundingTokens
    );
    const rightGrounding = groundingAfterRangeEdit(
      right,
      boundaryMs,
      rightEnd,
      groundingTokens
    );
    await tx
      .update(segmentClip)
      .set({
        adjustedEndMs: boundaryMs === left.endMs ? null : boundaryMs,
        decidedAt: null,
        decidedBy: null,
        flags: leftGrounding.flags,
        grounded: leftGrounding.grounded,
        groundingScore: leftGrounding.groundingScore,
        rejectNote: null,
        rejectReason: null,
        reviewFix: null,
        reviewNotes: null,
        reviewScores: null,
        status: "proposed",
      })
      .where(eq(segmentClip.id, left.id));
    await tx
      .update(segmentClip)
      .set({
        adjustedStartMs: boundaryMs === right.startMs ? null : boundaryMs,
        decidedAt: null,
        decidedBy: null,
        flags: rightGrounding.flags,
        grounded: rightGrounding.grounded,
        groundingScore: rightGrounding.groundingScore,
        rejectNote: null,
        rejectReason: null,
        reviewFix: null,
        reviewNotes: null,
        reviewScores: null,
        status: "proposed",
      })
      .where(eq(segmentClip.id, right.id));
    await markSegmentPlanEdited(tx, left.runId, true);
    await recordAudit(tx, {
      action: "segment.boundaries_adjusted",
      actorUserId: userId,
      entityId: left.runId,
      entityType: "segment_plan_run",
      metadata: {
        boundaryMs,
        deltaMs: boundaryMs - right.startMs,
        leftSegmentId: left.id,
        previousLeftEndMs: left.adjustedEndMs ?? left.endMs,
        previousRightStartMs: right.adjustedStartMs ?? right.startMs,
        rightSegmentId: right.id,
      },
      organizationId,
    });
    return left.sourceId;
  });
  if (!sourceId) {
    return { error: "Those chapters are no longer adjacent." };
  }

  revalidatePath(`/sources/${sourceId}`);
  return { success: true };
}

const mergeSchema = z.object({
  absorbedId: z.uuid(),
  destinationId: z.uuid(),
});

function preferredAnchorRow<
  T extends { anchorText: string | null; grounded: boolean },
>(destination: T, absorbed: T): T {
  if (destination.grounded && destination.anchorText?.trim()) {
    return destination;
  }
  return absorbed.grounded && absorbed.anchorText?.trim()
    ? absorbed
    : destination;
}

type SegmentClipRow = typeof segmentClip.$inferSelect;

function auditSegmentSnapshot(row: SegmentClipRow): Record<string, unknown> {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

function sameKeepPlan(
  absorbed: SegmentClipRow,
  destination: SegmentClipRow
): boolean {
  return (
    absorbed.kind === "keep" &&
    destination.kind === "keep" &&
    absorbed.sourceId === destination.sourceId &&
    absorbed.runId === destination.runId
  );
}

function mergedSegmentFlags(
  left: SegmentClipRow,
  right: SegmentClipRow,
  anchorGrounded: boolean
): string[] {
  const staleDerivedFlags = new Set([
    "long_outlier",
    "no_anchor",
    "same_topic_neighbors",
    "short_outlier",
    "ungrounded_after_edit",
  ]);
  const inherited = [left.flags, right.flags].flatMap((value) =>
    Array.isArray(value)
      ? (value as string[]).filter((flag) => !staleDerivedFlags.has(flag))
      : []
  );
  const flags = new Set([
    ...inherited,
    "human_merged",
    "needs_metadata_review",
  ]);
  if (!anchorGrounded) {
    flags.add("no_anchor");
  }
  return [...flags];
}

async function mergeCandidateRunId(
  tx: OrgTransaction,
  absorbedId: string,
  destinationId: string
): Promise<string | null> {
  const candidates = await tx
    .select()
    .from(segmentClip)
    .where(inArray(segmentClip.id, [absorbedId, destinationId]));
  const absorbed = candidates.find((row) => row.id === absorbedId);
  const destination = candidates.find((row) => row.id === destinationId);
  return absorbed && destination && sameKeepPlan(absorbed, destination)
    ? destination.runId
    : null;
}

async function persistSegmentMerge(
  tx: OrgTransaction,
  rows: SegmentClipRow[],
  request: {
    absorbedId: string;
    destinationId: string;
    organizationId: string;
    userId: string;
  }
): Promise<string | null> {
  const absorbed = rows.find((row) => row.id === request.absorbedId);
  const destination = rows.find((row) => row.id === request.destinationId);
  if (!(absorbed && destination && sameKeepPlan(absorbed, destination))) {
    return null;
  }
  const absorbedPosition = rows.findIndex((row) => row.id === absorbed.id);
  const destinationPosition = rows.findIndex(
    (row) => row.id === destination.id
  );
  if (Math.abs(absorbedPosition - destinationPosition) !== 1) {
    return null;
  }
  const [left, right] =
    absorbedPosition < destinationPosition
      ? [absorbed, destination]
      : [destination, absorbed];
  const anchorSource = preferredAnchorRow(destination, absorbed);
  const anchorGrounded = Boolean(
    anchorSource.grounded && anchorSource.anchorText?.trim()
  );
  const mergedValues = {
    adjustedEndMs: right.adjustedEndMs,
    adjustedStartMs: left.adjustedStartMs,
    anchorText: anchorGrounded ? anchorSource.anchorText : null,
    decidedAt: null,
    decidedBy: null,
    endMs: right.endMs,
    flags: mergedSegmentFlags(left, right, anchorGrounded),
    grounded: anchorGrounded,
    groundingScore: anchorGrounded ? anchorSource.groundingScore : 0,
    rawEndMs: Math.max(left.rawEndMs, right.rawEndMs),
    rawStartMs: Math.min(left.rawStartMs, right.rawStartMs),
    rejectNote: null,
    rejectReason: null,
    reviewFix: null,
    reviewNotes: null,
    reviewScores: null,
    startMs: left.startMs,
    status: "proposed" as const,
  };
  await tx
    .update(segmentClip)
    .set(mergedValues)
    .where(eq(segmentClip.id, destination.id));
  await tx.delete(segmentClip).where(eq(segmentClip.id, absorbed.id));

  const remaining = rows.filter((row) => row.id !== absorbed.id);
  const destinationAfterIdx = remaining.findIndex(
    (row) => row.id === destination.id
  );
  for (const [idx, row] of remaining.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: one small ordered plan, reindexed atomically inside the same transaction
    await tx.update(segmentClip).set({ idx }).where(eq(segmentClip.id, row.id));
  }
  await markSegmentPlanEdited(tx, destination.runId, true);
  await recordAudit(tx, {
    action: "segment.merged",
    actorUserId: request.userId,
    entityId: destination.id,
    entityType: "segment_clip",
    metadata: {
      absorbed: auditSegmentSnapshot(absorbed),
      destinationAfter: {
        ...auditSegmentSnapshot(destination),
        ...mergedValues,
        idx: destinationAfterIdx,
      },
      destinationBefore: auditSegmentSnapshot(destination),
      destinationId: destination.id,
    },
    organizationId: request.organizationId,
  });
  return destination.sourceId;
}

async function mergeSegmentsInTransaction(
  tx: OrgTransaction,
  request: {
    absorbedId: string;
    destinationId: string;
    organizationId: string;
    userId: string;
  }
): Promise<string | null> {
  const runId = await mergeCandidateRunId(
    tx,
    request.absorbedId,
    request.destinationId
  );
  if (!runId) {
    return null;
  }
  const run = await lockSegmentPlan(tx, runId);
  if (run?.status !== "ready") {
    return null;
  }
  const rows = await tx
    .select()
    .from(segmentClip)
    .where(eq(segmentClip.runId, runId))
    .orderBy(segmentClip.idx);
  return await persistSegmentMerge(tx, rows, request);
}

export async function mergeSegmentAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = mergeSchema.safeParse({
    absorbedId: formData.get("absorbedId"),
    destinationId: formData.get("destinationId"),
  });
  if (!parsed.success || parsed.data.absorbedId === parsed.data.destinationId) {
    return { error: "Invalid merge request." };
  }
  const { absorbedId, destinationId } = parsed.data;
  const { organizationId, userId } = await requireOrg();

  const sourceId = await withOrgScope(organizationId, (tx) =>
    mergeSegmentsInTransaction(tx, {
      absorbedId,
      destinationId,
      organizationId,
      userId,
    })
  );
  if (!sourceId) {
    return { error: "Only adjacent kept chapters can be merged." };
  }
  revalidatePath(`/sources/${sourceId}`);
  return { success: true };
}
