"use server";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { recordAudit } from "@/lib/audit";
import { momentCandidate, momentDiscoveryRun, source } from "@/lib/db/schema";
import { type OrgTransaction, withOrgScope } from "@/lib/db/tenant";
import {
  discoveryConfigured,
  dispatchDiscovery,
} from "@/lib/intelligence/discover-enqueue";
import { terminalDiscoveryFailureStatus } from "@/lib/intelligence/discovery-state";
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

const DISCOVERY_DISPATCH_ERROR =
  "Moment discovery could not be queued. Try again.";

async function lockMomentDiscovery(
  tx: OrgTransaction,
  runId: string
): Promise<{ attempts: number; editVersion: number; status: string } | null> {
  // Candidate ids and boundaries can be replaced together at finalization.
  // All human mutations and destructive reruns therefore serialize on the
  // owning run, then re-read their candidate after taking the lock.
  await tx.execute(
    sql`SELECT ${momentDiscoveryRun.id} FROM ${momentDiscoveryRun} WHERE ${momentDiscoveryRun.id} = ${runId} FOR UPDATE`
  );
  const [run] = await tx
    .select({
      attempts: momentDiscoveryRun.attempts,
      editVersion: momentDiscoveryRun.editVersion,
      status: momentDiscoveryRun.status,
    })
    .from(momentDiscoveryRun)
    .where(eq(momentDiscoveryRun.id, runId))
    .limit(1);
  return run ?? null;
}

async function markMomentDiscoveryEdited(
  tx: OrgTransaction,
  runId: string
): Promise<void> {
  await tx
    .update(momentDiscoveryRun)
    .set({
      editVersion: sql`${momentDiscoveryRun.editVersion} + 1`,
      humanEditedAt: new Date(),
    })
    .where(eq(momentDiscoveryRun.id, runId));
}

const decideSchema = z.object({
  candidateId: z.uuid(),
  decision: z.enum(["accepted", "shortlisted", "rejected", "proposed"]),
  rejectNote: z.string().trim().max(500).optional(),
  rejectReason: z.enum(REJECT_REASONS).optional(),
});

interface MomentDecisionRequest extends z.infer<typeof decideSchema> {
  organizationId: string;
  userId: string;
}

async function persistMomentDecision(
  tx: OrgTransaction,
  request: MomentDecisionRequest
): Promise<string | null> {
  const [candidate] = await tx
    .select({ runId: momentCandidate.runId })
    .from(momentCandidate)
    .where(eq(momentCandidate.id, request.candidateId))
    .limit(1);
  if (!candidate) {
    return null;
  }
  const run = await lockMomentDiscovery(tx, candidate.runId);
  if (run?.status !== "ready") {
    return null;
  }
  const [row] = await tx
    .select({
      runId: momentCandidate.runId,
      sourceId: momentCandidate.sourceId,
    })
    .from(momentCandidate)
    .where(eq(momentCandidate.id, request.candidateId))
    .limit(1);
  if (!row || row.runId !== candidate.runId) {
    return null;
  }
  const rejected = request.decision === "rejected";
  await tx
    .update(momentCandidate)
    .set({
      decidedAt: request.decision === "proposed" ? null : new Date(),
      decidedBy: request.decision === "proposed" ? null : request.userId,
      rejectNote: rejected ? (request.rejectNote ?? null) : null,
      rejectReason: rejected ? (request.rejectReason ?? null) : null,
      status: request.decision,
    })
    .where(eq(momentCandidate.id, request.candidateId));
  await markMomentDiscoveryEdited(tx, row.runId);
  await recordAudit(tx, {
    action: `moment.${request.decision}`,
    actorUserId: request.userId,
    entityId: request.candidateId,
    entityType: "moment_candidate",
    metadata: {
      candidateId: request.candidateId,
      ...(rejected ? { reason: request.rejectReason } : {}),
    },
    organizationId: request.organizationId,
  });
  return row.sourceId;
}

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

  const sourceId = await withOrgScope(organizationId, (tx) =>
    persistMomentDecision(tx, {
      candidateId,
      decision,
      organizationId,
      rejectNote,
      rejectReason,
      userId,
    })
  );
  if (!sourceId) {
    return {
      error:
        "That moment changed or discovery is running. Refresh and try again.",
    };
  }

  revalidatePath(`/sources/${sourceId}`);
  return { success: true };
}

const boundsSchema = z.object({
  adjustedEndMs: z.coerce.number().int().nonnegative(),
  adjustedStartMs: z.coerce.number().int().nonnegative(),
  candidateId: z.uuid(),
});

const databaseCounterSchema = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d*)$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(2_147_483_647));

const runVersionTokenSchema = z.object({
  attempts: databaseCounterSchema,
  editVersion: databaseCounterSchema,
  runId: z.uuid(),
});

interface MomentBoundsRequest extends z.infer<typeof boundsSchema> {
  organizationId: string;
  userId: string;
}

async function persistMomentBoundaries(
  tx: OrgTransaction,
  request: MomentBoundsRequest
): Promise<string | null> {
  const [candidate] = await tx
    .select({ runId: momentCandidate.runId })
    .from(momentCandidate)
    .where(eq(momentCandidate.id, request.candidateId))
    .limit(1);
  if (!candidate) {
    return null;
  }
  const run = await lockMomentDiscovery(tx, candidate.runId);
  if (run?.status !== "ready") {
    return null;
  }
  const [row] = await tx
    .select({
      adjustedEndMs: momentCandidate.adjustedEndMs,
      adjustedStartMs: momentCandidate.adjustedStartMs,
      endMs: momentCandidate.endMs,
      runId: momentCandidate.runId,
      sourceId: momentCandidate.sourceId,
      startMs: momentCandidate.startMs,
    })
    .from(momentCandidate)
    .where(eq(momentCandidate.id, request.candidateId))
    .limit(1);
  if (!row || row.runId !== candidate.runId) {
    return null;
  }
  const beforeEndMs = row.adjustedEndMs ?? row.endMs;
  const beforeStartMs = row.adjustedStartMs ?? row.startMs;
  await tx
    .update(momentCandidate)
    .set({
      adjustedEndMs: request.adjustedEndMs,
      adjustedStartMs: request.adjustedStartMs,
    })
    .where(eq(momentCandidate.id, request.candidateId));
  await markMomentDiscoveryEdited(tx, row.runId);
  await recordAudit(tx, {
    action: "moment.boundaries_adjusted",
    actorUserId: request.userId,
    entityId: request.candidateId,
    entityType: "moment_candidate",
    metadata: {
      after: {
        endMs: request.adjustedEndMs,
        startMs: request.adjustedStartMs,
      },
      before: { endMs: beforeEndMs, startMs: beforeStartMs },
      candidateId: request.candidateId,
      deltaEndMs: request.adjustedEndMs - row.endMs,
      deltaStartMs: request.adjustedStartMs - row.startMs,
    },
    organizationId: request.organizationId,
  });
  return row.sourceId;
}

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

  const sourceId = await withOrgScope(organizationId, (tx) =>
    persistMomentBoundaries(tx, {
      adjustedEndMs,
      adjustedStartMs,
      candidateId,
      organizationId,
      userId,
    })
  );
  if (!sourceId) {
    return {
      error:
        "That moment changed or discovery is running. Refresh and try again.",
    };
  }

  revalidatePath(`/sources/${sourceId}`);
  return { success: true };
}

// Re-running discovery is a HUMAN action (it re-spends model tokens) and
// replaces the candidate set only after a successful new run. Review
// decisions and boundary edits are protected by an exact run/attempt/version
// handshake: a confirmation shown before another editor's change cannot
// authorize deleting that newer work.
export interface RerunDiscoveryActionState extends ActionState {
  protectedAttempts?: number;
  protectedBoundaryEditCount?: number;
  protectedDecisionCount?: number;
  protectedEditVersion?: number;
  protectedRunId?: string;
  refreshRequired?: boolean;
}

interface DiscoveryTransitionRequest {
  dispatchLease: string;
  expectedAttempts: number | null;
  expectedEditVersion: number | null;
  expectedRunId: string | null;
  force: boolean;
  observedAttempts: number | null;
  observedEditVersion: number | null;
  observedRunId: string | null;
  organizationId: string;
  sourceId: string;
  userId: string;
}

interface HumanMomentWork {
  boundaryEditCount: number;
  decisionCount: number;
}

type DiscoveryTransition =
  | { dispatchLease: string; status: "queued" }
  | {
      status: "missing" | "running" | "stale-confirmation" | "stale-view";
    }
  | (HumanMomentWork & {
      editVersion: number;
      attempts: number;
      runId: string;
      status: "protected";
    });

async function visibleOrCreatedDiscoveryRun(
  tx: OrgTransaction,
  request: DiscoveryTransitionRequest
): Promise<{ created: boolean; id: string } | null> {
  // Authorize the parent source under RLS before inserting its child run.
  // PostgreSQL foreign-key checks alone do not establish tenant ownership.
  const [ownedSource] = await tx
    .select({ id: source.id })
    .from(source)
    .where(eq(source.id, request.sourceId))
    .limit(1);
  if (!ownedSource) {
    return null;
  }
  const [existing] = await tx
    .select({ id: momentDiscoveryRun.id })
    .from(momentDiscoveryRun)
    .where(eq(momentDiscoveryRun.sourceId, request.sourceId))
    .limit(1);
  if (existing) {
    return { created: false, id: existing.id };
  }
  const [created] = await tx
    .insert(momentDiscoveryRun)
    .values({
      counts: {
        dispatchLease: request.dispatchLease,
        dispatchState: "pending",
      },
      organizationId: request.organizationId,
      sourceId: request.sourceId,
      status: "pending",
    })
    .onConflictDoNothing({ target: momentDiscoveryRun.sourceId })
    .returning({ id: momentDiscoveryRun.id });
  if (created) {
    await recordAudit(tx, {
      action: "moment_discovery.started",
      actorUserId: request.userId,
      entityId: created.id,
      entityType: "moment_discovery_run",
      organizationId: request.organizationId,
    });
    return { created: true, id: created.id };
  }
  const [conflicted] = await tx
    .select({ id: momentDiscoveryRun.id })
    .from(momentDiscoveryRun)
    .where(eq(momentDiscoveryRun.sourceId, request.sourceId))
    .limit(1);
  return conflicted ? { created: false, id: conflicted.id } : null;
}

async function readHumanMomentWork(
  tx: OrgTransaction,
  runId: string
): Promise<HumanMomentWork> {
  const [facts] = await tx
    .select({
      boundaryEditCount: sql<number>`count(*) FILTER (WHERE ${momentCandidate.adjustedStartMs} IS NOT NULL OR ${momentCandidate.adjustedEndMs} IS NOT NULL)::int`,
      decisionCount: sql<number>`count(*) FILTER (WHERE ${momentCandidate.status} <> 'proposed')::int`,
    })
    .from(momentCandidate)
    .where(eq(momentCandidate.runId, runId));
  return {
    boundaryEditCount: Number(facts?.boundaryEditCount ?? 0),
    decisionCount: Number(facts?.decisionCount ?? 0),
  };
}

async function transitionDiscoveryRun(
  tx: OrgTransaction,
  request: DiscoveryTransitionRequest
): Promise<DiscoveryTransition> {
  const resolved = await visibleOrCreatedDiscoveryRun(tx, request);
  if (!resolved) {
    return { status: "missing" };
  }
  if (resolved.created) {
    return { dispatchLease: request.dispatchLease, status: "queued" };
  }
  const locked = await lockMomentDiscovery(tx, resolved.id);
  if (!locked) {
    return { status: "missing" };
  }
  if (locked.status === "processing" || locked.status === "pending") {
    return { status: "running" };
  }
  if (
    request.force &&
    (request.expectedRunId !== resolved.id ||
      request.expectedAttempts !== locked.attempts ||
      request.expectedEditVersion !== locked.editVersion)
  ) {
    return { status: "stale-confirmation" };
  }
  if (
    !request.force &&
    (request.observedRunId !== resolved.id ||
      request.observedAttempts !== locked.attempts ||
      request.observedEditVersion !== locked.editVersion)
  ) {
    return { status: "stale-view" };
  }
  const humanWork = await readHumanMomentWork(tx, resolved.id);
  const protectedWork =
    locked.editVersion > 0 ||
    humanWork.decisionCount > 0 ||
    humanWork.boundaryEditCount > 0;
  if (protectedWork && !request.force) {
    return {
      ...humanWork,
      attempts: locked.attempts,
      editVersion: locked.editVersion,
      runId: resolved.id,
      status: "protected",
    };
  }
  await tx
    .update(momentDiscoveryRun)
    .set({
      counts: sql`(
        COALESCE(${momentDiscoveryRun.counts}, '{}'::jsonb)
        - 'stage' - 'dispatchId' - 'dispatchedAt'
      ) || jsonb_build_object(
        'dispatchLease', ${request.dispatchLease}::text,
        'dispatchState', 'pending'
      )`,
      error: null,
      status: "pending",
    })
    .where(eq(momentDiscoveryRun.id, resolved.id));
  await recordAudit(tx, {
    action: "moment_discovery.rerun",
    actorUserId: request.userId,
    entityId: resolved.id,
    entityType: "moment_discovery_run",
    metadata: request.force
      ? {
          authorizedAttempt: locked.attempts,
          authorizedBoundaryEditCount: humanWork.boundaryEditCount,
          authorizedDecisionCount: humanWork.decisionCount,
          authorizedEditVersion: locked.editVersion,
          force: true,
          sourceId: request.sourceId,
        }
      : { sourceId: request.sourceId },
    organizationId: request.organizationId,
  });
  return { dispatchLease: request.dispatchLease, status: "queued" };
}

export async function rerunDiscoveryAction(
  _state: RerunDiscoveryActionState,
  formData: FormData
): Promise<RerunDiscoveryActionState> {
  const parsedId = z.uuid().safeParse(formData.get("sourceId"));
  if (!parsedId.success) {
    return { error: "Invalid source reference." };
  }
  const force = formData.get("force") === "true";
  const observed = runVersionTokenSchema.safeParse({
    attempts: formData.get("observedAttempts"),
    editVersion: formData.get("observedEditVersion"),
    runId: formData.get("observedRunId"),
  });
  const confirmation = force
    ? runVersionTokenSchema.safeParse({
        attempts: formData.get("expectedAttempts"),
        editVersion: formData.get("expectedEditVersion"),
        runId: formData.get("expectedRunId"),
      })
    : null;
  if (force && !confirmation?.success) {
    return {
      error: "Review the latest moments before discarding their edits.",
    };
  }
  const expectedAttempts = confirmation?.success
    ? confirmation.data.attempts
    : null;
  const expectedEditVersion = confirmation?.success
    ? confirmation.data.editVersion
    : null;
  const expectedRunId = confirmation?.success ? confirmation.data.runId : null;
  const { organizationId, userId } = await requireOrg();
  if (!discoveryConfigured()) {
    return { error: "AI moment discovery is not configured." };
  }
  const dispatchLease = randomUUID();
  const transition = await withOrgScope(organizationId, (tx) =>
    transitionDiscoveryRun(tx, {
      dispatchLease,
      expectedAttempts,
      expectedEditVersion,
      expectedRunId,
      force,
      observedAttempts: observed.success ? observed.data.attempts : null,
      observedEditVersion: observed.success ? observed.data.editVersion : null,
      observedRunId: observed.success ? observed.data.runId : null,
      organizationId,
      sourceId: parsedId.data,
      userId,
    })
  );
  if (transition.status === "running") {
    return { error: "Discovery is already running." };
  }
  if (transition.status === "protected") {
    return {
      error:
        "These moments have review decisions or boundary edits. Running discovery again would discard them.",
      protectedAttempts: transition.attempts,
      protectedBoundaryEditCount: transition.boundaryEditCount,
      protectedDecisionCount: transition.decisionCount,
      protectedEditVersion: transition.editVersion,
      protectedRunId: transition.runId,
    };
  }
  if (transition.status === "stale-confirmation") {
    return {
      error:
        "The moment reviews changed. Refreshing them before you can run discovery.",
      refreshRequired: true,
    };
  }
  if (transition.status === "stale-view") {
    return {
      error:
        "The moments changed since this page loaded. Refreshing the latest reviews.",
      refreshRequired: true,
    };
  }
  if (transition.status !== "queued") {
    return { error: "Could not start moment discovery." };
  }

  try {
    const dispatchId = await dispatchDiscovery({
      dispatchLease: transition.dispatchLease,
      organizationId,
      sourceId: parsedId.data,
    });
    await withOrgScope(organizationId, async (tx) => {
      const [confirmed] = await tx
        .update(momentDiscoveryRun)
        .set({
          counts: sql`COALESCE(${momentDiscoveryRun.counts}, '{}'::jsonb) || jsonb_build_object(
            'dispatchedAt', ${new Date().toISOString()}::text,
            'dispatchId', ${dispatchId}::text,
            'dispatchLease', ${transition.dispatchLease}::text,
            'dispatchState', 'confirmed'
          )`,
        })
        .where(
          and(
            eq(momentDiscoveryRun.sourceId, parsedId.data),
            sql`${momentDiscoveryRun.counts}->>'dispatchLease' = ${transition.dispatchLease}`,
            eq(momentDiscoveryRun.status, "pending")
          )
        )
        .returning({ id: momentDiscoveryRun.id });
      if (confirmed) {
        await recordAudit(tx, {
          action: "moment_discovery.dispatched",
          actorUserId: userId,
          entityId: confirmed.id,
          entityType: "moment_discovery_run",
          metadata: { dispatchId },
          organizationId,
        });
      }
    });
  } catch (error) {
    console.error(
      `[discover] could not dispatch source ${parsedId.data}:`,
      error
    );
    await withOrgScope(organizationId, async (tx) => {
      const [failedRun] = await tx
        .update(momentDiscoveryRun)
        .set({
          error: DISCOVERY_DISPATCH_ERROR,
          status: terminalDiscoveryFailureStatus,
        })
        .where(
          and(
            eq(momentDiscoveryRun.sourceId, parsedId.data),
            sql`${momentDiscoveryRun.counts}->>'dispatchLease' = ${transition.dispatchLease}`,
            eq(momentDiscoveryRun.status, "pending")
          )
        )
        .returning({
          id: momentDiscoveryRun.id,
          status: momentDiscoveryRun.status,
        });
      if (failedRun) {
        await recordAudit(tx, {
          action: "moment_discovery.dispatch_failed",
          actorUserId: userId,
          entityId: failedRun.id,
          entityType: "moment_discovery_run",
          metadata: { preservedCandidates: failedRun.status === "ready" },
          organizationId,
        });
      }
    });
    return { error: DISCOVERY_DISPATCH_ERROR };
  }

  revalidatePath(`/sources/${parsedId.data}`);
  return { success: true };
}
