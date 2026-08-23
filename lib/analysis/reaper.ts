import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "@/lib/audit";
import { sourceAnalysis } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { ANALYSIS_STALL_TTL_MINUTES } from "./window";

const REAP_BATCH_SIZE = 50;
const STALLED_ERROR = "Analysis stopped unexpectedly. Try again.";

// Same contract as the ingest and transcription reapers: "claims to be
// processing and nothing has written to the row for a whole stall window",
// evaluated in the database, scoped to processing only — pending is a
// legitimate queue state.
export const isStalledAnalysis = and(
  eq(sourceAnalysis.status, "processing"),
  lt(
    sourceAnalysis.updatedAt,
    sql`now() - make_interval(mins => ${ANALYSIS_STALL_TTL_MINUTES})`
  )
);

export async function reapStalledAnalyses(
  organizationId: string
): Promise<number> {
  const stalled = await withOrgScope(organizationId, (tx) =>
    tx
      .select({ id: sourceAnalysis.id, sourceId: sourceAnalysis.sourceId })
      .from(sourceAnalysis)
      .where(isStalledAnalysis)
      .limit(REAP_BATCH_SIZE)
  );
  if (stalled.length === 0) {
    return 0;
  }

  await withOrgScope(organizationId, async (tx) => {
    await tx
      .update(sourceAnalysis)
      .set({ error: STALLED_ERROR, status: "failed" })
      .where(
        and(
          eq(sourceAnalysis.status, "processing"),
          inArray(
            sourceAnalysis.id,
            stalled.map((row) => row.id)
          )
        )
      );
    await Promise.all(
      stalled.map((row) =>
        recordAudit(tx, {
          action: "analysis.stalled",
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
  });
  return stalled.length;
}

export function scheduleAnalysisReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStalledAnalyses(organizationId);
      if (reaped > 0) {
        console.info(
          `[analysis] marked ${reaped} stalled analysis run(s) failed in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[analysis] stalled sweep failed:", error);
    }
  });
}
