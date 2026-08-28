import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "@/lib/audit";
import { segmentPlanRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { dispatchSegmentPlan } from "./segment-enqueue";
import { SEGMENT_STALL_TTL_MINUTES } from "./window";

const REAP_BATCH_SIZE = 50;
const STALLED_ERROR = "Segment planning stopped unexpectedly. Try again.";
const REDISPATCH_ERROR = "Segment planning could not be re-queued. Try again.";

// Processing silence means the worker died. Pending silence is different:
// the action may have committed immediately before its dispatch process died.
// Re-dispatching is safe because claimRun is idempotent; one task wins and
// every duplicate returns without spending.
const segmentPlanSilentTooLong = lt(
  segmentPlanRun.updatedAt,
  sql`now() - make_interval(mins => ${SEGMENT_STALL_TTL_MINUTES})`
);

export const isStalledSegmentPlan = or(
  and(eq(segmentPlanRun.status, "processing"), segmentPlanSilentTooLong),
  and(
    eq(segmentPlanRun.status, "pending"),
    sql`${segmentPlanRun.counts}->>'dispatchState' = 'pending'`,
    segmentPlanSilentTooLong
  )
);

export async function reapStalledSegmentPlans(
  organizationId: string
): Promise<number> {
  const dispatchLease = randomUUID();
  const claimed = await withOrgScope(organizationId, async (tx) => {
    const candidates = await tx
      .select({
        id: segmentPlanRun.id,
        sourceId: segmentPlanRun.sourceId,
        status: segmentPlanRun.status,
      })
      .from(segmentPlanRun)
      .where(isStalledSegmentPlan)
      .limit(REAP_BATCH_SIZE);
    if (candidates.length === 0) {
      return { pending: [], processing: [] };
    }
    const candidateIds = candidates.map((row) => row.id);
    const processing = await tx
      .update(segmentPlanRun)
      .set({ error: STALLED_ERROR, status: "failed" })
      .where(
        and(
          eq(segmentPlanRun.status, "processing"),
          isStalledSegmentPlan,
          inArray(segmentPlanRun.id, candidateIds)
        )
      )
      .returning({
        id: segmentPlanRun.id,
        sourceId: segmentPlanRun.sourceId,
        status: segmentPlanRun.status,
      });
    const pending = await tx
      .update(segmentPlanRun)
      .set({ counts: { dispatchLease, dispatchState: "pending" } })
      .where(
        and(
          eq(segmentPlanRun.status, "pending"),
          isStalledSegmentPlan,
          inArray(segmentPlanRun.id, candidateIds)
        )
      )
      .returning({
        id: segmentPlanRun.id,
        sourceId: segmentPlanRun.sourceId,
        status: segmentPlanRun.status,
      });
    await Promise.all(
      [...processing, ...pending].map((row) =>
        recordAudit(tx, {
          action:
            row.status === "pending"
              ? "segment_plan.redispatch_scheduled"
              : "segment_plan.stalled",
          actorUserId: null,
          entityId: row.id,
          entityType: "segment_plan_run",
          metadata: {
            sourceId: row.sourceId,
            stallMinutes: SEGMENT_STALL_TTL_MINUTES,
          },
          organizationId,
        })
      )
    );
    return {
      pending: pending.map((row) => ({ ...row, dispatchLease })),
      processing,
    };
  });
  const claimedCount = claimed.pending.length + claimed.processing.length;
  if (claimedCount === 0) {
    return 0;
  }

  const redispatched = await Promise.allSettled(
    claimed.pending.map((row) =>
      dispatchSegmentPlan({
        dispatchLease: row.dispatchLease,
        organizationId,
        sourceId: row.sourceId,
      })
    )
  );
  const confirmed = redispatched.flatMap((result, index) => {
    const row = claimed.pending[index];
    return result.status === "fulfilled" && row
      ? [{ dispatchId: result.value, row }]
      : [];
  });
  const failedIds = redispatched.flatMap((result, index) => {
    const row = claimed.pending[index];
    return result.status === "rejected" && row ? [row.id] : [];
  });
  if (confirmed.length > 0 || failedIds.length > 0) {
    await withOrgScope(organizationId, async (tx) => {
      await Promise.all(
        confirmed.map(async ({ dispatchId, row }) => {
          const [updated] = await tx
            .update(segmentPlanRun)
            .set({
              counts: {
                dispatchedAt: new Date().toISOString(),
                dispatchId,
                dispatchLease: row.dispatchLease,
                dispatchState: "confirmed",
              },
            })
            .where(
              and(
                eq(segmentPlanRun.id, row.id),
                sql`${segmentPlanRun.counts}->>'dispatchLease' = ${row.dispatchLease}`,
                eq(segmentPlanRun.status, "pending")
              )
            )
            .returning({ id: segmentPlanRun.id });
          return updated
            ? recordAudit(tx, {
                action: "segment_plan.redispatched",
                actorUserId: null,
                entityId: updated.id,
                entityType: "segment_plan_run",
                metadata: { dispatchId },
                organizationId,
              })
            : undefined;
        })
      );
      if (failedIds.length === 0) {
        return;
      }
      const failed = await tx
        .update(segmentPlanRun)
        .set({ error: REDISPATCH_ERROR, status: "failed" })
        .where(
          and(
            eq(segmentPlanRun.status, "pending"),
            sql`${segmentPlanRun.counts}->>'dispatchLease' = ${dispatchLease}`,
            inArray(segmentPlanRun.id, failedIds)
          )
        )
        .returning({ id: segmentPlanRun.id });
      await Promise.all(
        failed.map(({ id }) =>
          recordAudit(tx, {
            action: "segment_plan.redispatch_failed",
            actorUserId: null,
            entityId: id,
            entityType: "segment_plan_run",
            organizationId,
          })
        )
      );
    });
  }
  return claimedCount;
}

export function scheduleSegmentPlanReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStalledSegmentPlans(organizationId);
      if (reaped > 0) {
        console.info(
          `[segments] recovered or reaped ${reaped} stalled plan run(s) in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[segments] stalled sweep failed:", error);
    }
  });
}
