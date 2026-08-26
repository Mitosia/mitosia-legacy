import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "@/lib/audit";
import { segmentPlanRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { SEGMENT_STALL_TTL_MINUTES } from "./window";

const REAP_BATCH_SIZE = 50;
const STALLED_ERROR = "Segment planning stopped unexpectedly. Try again.";

// Same contract as the discovery reaper: processing-only, silence-based.
export const isStalledSegmentPlan = and(
  eq(segmentPlanRun.status, "processing"),
  lt(
    segmentPlanRun.updatedAt,
    sql`now() - make_interval(mins => ${SEGMENT_STALL_TTL_MINUTES})`
  )
);

export async function reapStalledSegmentPlans(
  organizationId: string
): Promise<number> {
  const stalled = await withOrgScope(organizationId, (tx) =>
    tx
      .select({ id: segmentPlanRun.id, sourceId: segmentPlanRun.sourceId })
      .from(segmentPlanRun)
      .where(isStalledSegmentPlan)
      .limit(REAP_BATCH_SIZE)
  );
  if (stalled.length === 0) {
    return 0;
  }

  await withOrgScope(organizationId, async (tx) => {
    await tx
      .update(segmentPlanRun)
      .set({ error: STALLED_ERROR, status: "failed" })
      .where(
        and(
          eq(segmentPlanRun.status, "processing"),
          inArray(
            segmentPlanRun.id,
            stalled.map((row) => row.id)
          )
        )
      );
    await Promise.all(
      stalled.map((row) =>
        recordAudit(tx, {
          action: "segment_plan.stalled",
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
  });
  return stalled.length;
}

export function scheduleSegmentPlanReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStalledSegmentPlans(organizationId);
      if (reaped > 0) {
        console.info(
          `[segments] marked ${reaped} stalled plan run(s) failed in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[segments] stalled sweep failed:", error);
    }
  });
}
