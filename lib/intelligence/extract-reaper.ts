import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "@/lib/audit";
import { sourceExtractionRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { EXTRACTION_STALL_TTL_MINUTES } from "./window";

const REAP_BATCH_SIZE = 50;
const STALLED_ERROR = "Extraction stopped unexpectedly. Try again.";

// Same contract as the analysis reaper: "claims to be processing and
// nothing has written to the row for a whole stall window", evaluated in
// the database, scoped to processing only.
export const isStalledExtraction = and(
  eq(sourceExtractionRun.status, "processing"),
  lt(
    sourceExtractionRun.updatedAt,
    sql`now() - make_interval(mins => ${EXTRACTION_STALL_TTL_MINUTES})`
  )
);

export async function reapStalledExtractions(
  organizationId: string
): Promise<number> {
  const stalled = await withOrgScope(organizationId, (tx) =>
    tx
      .select({
        id: sourceExtractionRun.id,
        sourceId: sourceExtractionRun.sourceId,
      })
      .from(sourceExtractionRun)
      .where(isStalledExtraction)
      .limit(REAP_BATCH_SIZE)
  );
  if (stalled.length === 0) {
    return 0;
  }

  await withOrgScope(organizationId, async (tx) => {
    await tx
      .update(sourceExtractionRun)
      .set({ error: STALLED_ERROR, status: "failed" })
      .where(
        and(
          eq(sourceExtractionRun.status, "processing"),
          inArray(
            sourceExtractionRun.id,
            stalled.map((row) => row.id)
          )
        )
      );
    await Promise.all(
      stalled.map((row) =>
        recordAudit(tx, {
          action: "source_extraction.stalled",
          actorUserId: null,
          entityId: row.id,
          entityType: "source_extraction_run",
          metadata: {
            sourceId: row.sourceId,
            stallMinutes: EXTRACTION_STALL_TTL_MINUTES,
          },
          organizationId,
        })
      )
    );
  });
  return stalled.length;
}

export function scheduleExtractionReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStalledExtractions(organizationId);
      if (reaped > 0) {
        console.info(
          `[extract] marked ${reaped} stalled extraction run(s) failed in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[extract] stalled sweep failed:", error);
    }
  });
}
