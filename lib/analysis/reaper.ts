import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "@/lib/audit";
import { sourceAnalysis } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { dispatchAnalysis } from "./enqueue";
import { ANALYSIS_STALL_TTL_MINUTES } from "./window";

const REAP_BATCH_SIZE = 50;
const STALLED_ERROR = "Analysis stopped unexpectedly. Try again.";

// Processing silence means the worker died. Pending silence means the
// durable intent may have been stranded between commit and dispatch (or the
// queue accepted an ambiguous request); CAS claim makes redispatch harmless.
const analysisSilentTooLong = lt(
  sourceAnalysis.updatedAt,
  sql`now() - make_interval(mins => ${ANALYSIS_STALL_TTL_MINUTES})`
);

export const isStalledAnalysis = and(
  or(
    eq(sourceAnalysis.status, "pending"),
    eq(sourceAnalysis.status, "processing")
  ),
  analysisSilentTooLong
);

export async function reapStalledAnalyses(
  organizationId: string
): Promise<number> {
  const claimed = await withOrgScope(organizationId, async (tx) => {
    const stalled = await tx
      .select({ id: sourceAnalysis.id, sourceId: sourceAnalysis.sourceId })
      .from(sourceAnalysis)
      .where(isStalledAnalysis)
      .limit(REAP_BATCH_SIZE);
    if (stalled.length === 0) {
      return { pending: [], processing: [] };
    }
    const ids = stalled.map((row) => row.id);
    // Repeat the full silence predicate in both UPDATEs. A heartbeat or claim
    // between SELECT and UPDATE therefore wins the race.
    const processing = await tx
      .update(sourceAnalysis)
      .set({ error: STALLED_ERROR, status: "failed" })
      .where(
        and(
          eq(sourceAnalysis.status, "processing"),
          isStalledAnalysis,
          inArray(sourceAnalysis.id, ids)
        )
      )
      .returning({
        id: sourceAnalysis.id,
        sourceId: sourceAnalysis.sourceId,
      });
    const pending = await tx
      .update(sourceAnalysis)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(sourceAnalysis.status, "pending"),
          isStalledAnalysis,
          inArray(sourceAnalysis.id, ids)
        )
      )
      .returning({
        id: sourceAnalysis.id,
        sourceId: sourceAnalysis.sourceId,
      });
    await Promise.all(
      [
        ...processing.map((row) => ({
          action: "analysis.stalled",
          row,
        })),
        ...pending.map((row) => ({
          action: "analysis.redispatch_scheduled",
          row,
        })),
      ].map(({ action, row }) =>
        recordAudit(tx, {
          action,
          actorUserId: null,
          entityId: row.id,
          entityType: "source_analysis",
          metadata: {
            sourceId: row.sourceId,
            stallMinutes: ANALYSIS_STALL_TTL_MINUTES,
          },
          organizationId,
        })
      )
    );
    return { pending, processing };
  });
  const claimedCount = claimed.pending.length + claimed.processing.length;
  if (claimedCount === 0) {
    return 0;
  }

  const redispatched = await Promise.allSettled(
    claimed.pending.map((row) =>
      dispatchAnalysis({ organizationId, sourceId: row.sourceId })
    )
  );
  for (const [index, result] of redispatched.entries()) {
    if (result.status === "rejected") {
      console.error(
        `[analysis] stale pending redispatch failed for ${claimed.pending[index]?.sourceId}:`,
        result.reason
      );
    }
  }
  return claimedCount;
}

export function scheduleAnalysisReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStalledAnalyses(organizationId);
      if (reaped > 0) {
        console.info(
          `[analysis] recovered or reaped ${reaped} stalled analysis run(s) in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[analysis] stalled sweep failed:", error);
    }
  });
}
