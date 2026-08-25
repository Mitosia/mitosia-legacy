"use server";

import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { recordAudit } from "@/lib/audit";
import { momentCandidate, momentDiscoveryRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { enqueueDiscoveryRerun } from "@/lib/intelligence/discover-enqueue";
import { requireOrg } from "@/lib/org";

// Review actions for moment candidates (S6, D5): every decision and
// boundary adjustment is a first-class column write PLUS an audit entry in
// the same transaction — these rows ARE the M1 measurement, never client
// state. Conventions follow lib/actions/intelligence.ts: zod-parse the
// form, requireOrg, withOrgScope, audit in-tx, revalidatePath.

const REJECT_REASONS = [
  "not_interesting",
  "wrong_boundaries",
  "out_of_context",
  "sensitive",
  "duplicate",
  "other",
] as const;

const decideSchema = z.object({
  candidateId: z.uuid(),
  decision: z.enum(["accepted", "shortlisted", "rejected", "proposed"]),
  rejectNote: z.string().trim().max(500).optional(),
  rejectReason: z.enum(REJECT_REASONS).optional(),
});

export async function decideMomentAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = decideSchema.safeParse({
    candidateId: formData.get("candidateId"),
    decision: formData.get("decision"),
    rejectNote: formData.get("rejectNote") ?? undefined,
    rejectReason: formData.get("rejectReason") ?? undefined,
  });
  if (!parsed.success) {
    return { error: "Invalid review decision." };
  }
  const { candidateId, decision, rejectNote, rejectReason } = parsed.data;
  if (decision === "rejected" && !rejectReason) {
    return { error: "Pick a reason to reject." };
  }
  const { organizationId, userId } = await requireOrg();

  const sourceId = await withOrgScope(organizationId, async (tx) => {
    const [row] = await tx
      .select({ sourceId: momentCandidate.sourceId })
      .from(momentCandidate)
      .where(eq(momentCandidate.id, candidateId))
      .limit(1);
    if (!row) {
      return null;
    }
    const rejected = decision === "rejected";
    await tx
      .update(momentCandidate)
      .set({
        decidedAt: decision === "proposed" ? null : new Date(),
        decidedBy: decision === "proposed" ? null : userId,
        rejectNote: rejected ? (rejectNote ?? null) : null,
        rejectReason: rejected ? (rejectReason ?? null) : null,
        status: decision,
      })
      .where(eq(momentCandidate.id, candidateId));
    await recordAudit(tx, {
      action: `moment.${decision}`,
      actorUserId: userId,
      entityId: candidateId,
      entityType: "moment_candidate",
      metadata: {
        candidateId,
        ...(rejected ? { reason: rejectReason } : {}),
      },
      organizationId,
    });
    return row.sourceId;
  });
  if (!sourceId) {
    return { error: "That candidate no longer exists." };
  }

  revalidatePath(`/sources/${sourceId}`);
  return { success: true };
}

const boundsSchema = z.object({
  adjustedEndMs: z.coerce.number().int().nonnegative(),
  adjustedStartMs: z.coerce.number().int().nonnegative(),
  candidateId: z.uuid(),
});

export async function saveBoundariesAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = boundsSchema.safeParse({
    adjustedEndMs: formData.get("adjustedEndMs"),
    adjustedStartMs: formData.get("adjustedStartMs"),
    candidateId: formData.get("candidateId"),
  });
  if (
    !parsed.success ||
    parsed.data.adjustedEndMs <= parsed.data.adjustedStartMs
  ) {
    return { error: "Invalid boundaries." };
  }
  const { adjustedEndMs, adjustedStartMs, candidateId } = parsed.data;
  const { organizationId, userId } = await requireOrg();

  const sourceId = await withOrgScope(organizationId, async (tx) => {
    const [row] = await tx
      .select({
        endMs: momentCandidate.endMs,
        sourceId: momentCandidate.sourceId,
        startMs: momentCandidate.startMs,
      })
      .from(momentCandidate)
      .where(eq(momentCandidate.id, candidateId))
      .limit(1);
    if (!row) {
      return null;
    }
    await tx
      .update(momentCandidate)
      .set({ adjustedEndMs, adjustedStartMs })
      .where(eq(momentCandidate.id, candidateId));
    // The deltas ARE the boundary-adjustment metric — recorded in the
    // audit trail so the measurement survives even a forced re-run's
    // delete-and-replace.
    await recordAudit(tx, {
      action: "moment.boundaries_adjusted",
      actorUserId: userId,
      entityId: candidateId,
      entityType: "moment_candidate",
      metadata: {
        candidateId,
        deltaEndMs: adjustedEndMs - row.endMs,
        deltaStartMs: adjustedStartMs - row.startMs,
      },
      organizationId,
    });
    return row.sourceId;
  });
  if (!sourceId) {
    return { error: "That candidate no longer exists." };
  }

  revalidatePath(`/sources/${sourceId}`);
  return { success: true };
}

// Re-running discovery is a HUMAN action (it re-spends model tokens), and
// it REFUSES while any candidate carries a review decision: re-runs
// delete-and-replace candidate rows, and decided rows are the M1 record —
// losing a strategist's review to a casual re-run is unacceptable. The
// force flag exists for deliberate resets (scripts, or a future confirm
// dialog), never as the default path.
export async function rerunDiscoveryAction(
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
      .select({
        id: momentDiscoveryRun.id,
        status: momentDiscoveryRun.status,
      })
      .from(momentDiscoveryRun)
      .where(eq(momentDiscoveryRun.sourceId, parsedId.data))
      .limit(1);
    const [decided] = await tx
      .select({ id: momentCandidate.id })
      .from(momentCandidate)
      .where(
        and(
          eq(momentCandidate.sourceId, parsedId.data),
          ne(momentCandidate.status, "proposed")
        )
      )
      .limit(1);
    return { decided: Boolean(decided), run: run ?? null };
  });
  if (
    state.run &&
    (state.run.status === "processing" || state.run.status === "pending")
  ) {
    return { error: "Discovery is already running." };
  }
  if (state.decided && !force) {
    return {
      error:
        "Some moments already carry review decisions. Re-running would discard them.",
    };
  }

  await withOrgScope(organizationId, (tx) =>
    recordAudit(tx, {
      action: state.run ? "moment_discovery.rerun" : "moment_discovery.started",
      actorUserId: userId,
      entityId: state.run?.id,
      entityType: "moment_discovery_run",
      metadata: force ? { force: true } : undefined,
      organizationId,
    })
  );
  await enqueueDiscoveryRerun({
    organizationId,
    sourceId: parsedId.data,
  });

  revalidatePath(`/sources/${parsedId.data}`);
  return { success: true };
}
