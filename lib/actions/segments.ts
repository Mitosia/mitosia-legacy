"use server";

import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { recordAudit } from "@/lib/audit";
import { segmentClip, segmentPlanRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import {
  enqueueSegmentPlan,
  enqueueSegmentPlanRerun,
} from "@/lib/intelligence/segment-enqueue";
import { requireOrg } from "@/lib/org";

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

// Planning is a human's button, never a chain: the plan heads toward
// spend-gated rendering, so the strategist chooses when. First click
// creates the run; re-plans refuse while decisions exist (below).
export async function planSegmentsAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsedId = z.uuid().safeParse(formData.get("sourceId"));
  if (!parsedId.success) {
    return { error: "Invalid source reference." };
  }
  const force = formData.get("force") === "true";
  const { organizationId, userId } = await requireOrg();

  const state = await withOrgScope(organizationId, async (tx) => {
    const [run] = await tx
      .select({ id: segmentPlanRun.id, status: segmentPlanRun.status })
      .from(segmentPlanRun)
      .where(eq(segmentPlanRun.sourceId, parsedId.data))
      .limit(1);
    const [decided] = await tx
      .select({ id: segmentClip.id })
      .from(segmentClip)
      .where(
        and(
          eq(segmentClip.sourceId, parsedId.data),
          ne(segmentClip.status, "proposed")
        )
      )
      .limit(1);
    return { decided: Boolean(decided), run: run ?? null };
  });
  if (
    state.run &&
    (state.run.status === "processing" || state.run.status === "pending")
  ) {
    return { error: "Segment planning is already running." };
  }
  if (state.decided && !force) {
    return {
      error:
        "Some segments already carry review decisions. Re-planning would discard them.",
    };
  }

  await withOrgScope(organizationId, (tx) =>
    recordAudit(tx, {
      action: state.run ? "segment_plan.rerun" : "segment_plan.started",
      actorUserId: userId,
      entityId: state.run?.id,
      entityType: "segment_plan_run",
      metadata: force ? { force: true } : undefined,
      organizationId,
    })
  );
  if (state.run) {
    await enqueueSegmentPlanRerun({
      organizationId,
      sourceId: parsedId.data,
    });
  } else {
    await enqueueSegmentPlan({ organizationId, sourceId: parsedId.data });
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

  const sourceId = await withOrgScope(organizationId, async (tx) => {
    const [row] = await tx
      .select({ sourceId: segmentClip.sourceId })
      .from(segmentClip)
      .where(eq(segmentClip.id, segmentId))
      .limit(1);
    if (!row) {
      return null;
    }
    const rejected = decision === "rejected";
    await tx
      .update(segmentClip)
      .set({
        decidedAt: decision === "proposed" ? null : new Date(),
        decidedBy: decision === "proposed" ? null : userId,
        rejectNote: rejected ? (rejectNote ?? null) : null,
        rejectReason: rejected ? (rejectReason ?? null) : null,
        status: decision,
      })
      .where(eq(segmentClip.id, segmentId));
    await recordAudit(tx, {
      action: `segment.${decision}`,
      actorUserId: userId,
      entityId: segmentId,
      entityType: "segment_clip",
      metadata: {
        segmentId,
        ...(rejected ? { reason: rejectReason } : {}),
      },
      organizationId,
    });
    return row.sourceId;
  });
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
    const [row] = await tx
      .select({ kind: segmentClip.kind, sourceId: segmentClip.sourceId })
      .from(segmentClip)
      .where(eq(segmentClip.id, parsedId.data))
      .limit(1);
    if (row?.kind !== "drop") {
      return null;
    }
    await tx
      .update(segmentClip)
      .set({ dropReason: null, kind: "keep", status: "proposed" })
      .where(eq(segmentClip.id, parsedId.data));
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

const boundsSchema = z.object({
  adjustedEndMs: z.coerce.number().int().nonnegative(),
  adjustedStartMs: z.coerce.number().int().nonnegative(),
  segmentId: z.uuid(),
});

export async function saveSegmentBoundariesAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = boundsSchema.safeParse({
    adjustedEndMs: formData.get("adjustedEndMs"),
    adjustedStartMs: formData.get("adjustedStartMs"),
    segmentId: formData.get("segmentId"),
  });
  if (
    !parsed.success ||
    parsed.data.adjustedEndMs <= parsed.data.adjustedStartMs
  ) {
    return { error: "Invalid boundaries." };
  }
  const { adjustedEndMs, adjustedStartMs, segmentId } = parsed.data;
  const { organizationId, userId } = await requireOrg();

  const sourceId = await withOrgScope(organizationId, async (tx) => {
    const [row] = await tx
      .select({
        endMs: segmentClip.endMs,
        sourceId: segmentClip.sourceId,
        startMs: segmentClip.startMs,
      })
      .from(segmentClip)
      .where(eq(segmentClip.id, segmentId))
      .limit(1);
    if (!row) {
      return null;
    }
    await tx
      .update(segmentClip)
      .set({ adjustedEndMs, adjustedStartMs })
      .where(eq(segmentClip.id, segmentId));
    // The deltas are the boundary-adjustment metric, preserved in the
    // audit trail across re-plans.
    await recordAudit(tx, {
      action: "segment.boundaries_adjusted",
      actorUserId: userId,
      entityId: segmentId,
      entityType: "segment_clip",
      metadata: {
        deltaEndMs: adjustedEndMs - row.endMs,
        deltaStartMs: adjustedStartMs - row.startMs,
        segmentId,
      },
      organizationId,
    });
    return row.sourceId;
  });
  if (!sourceId) {
    return { error: "That segment no longer exists." };
  }

  revalidatePath(`/sources/${sourceId}`);
  return { success: true };
}
