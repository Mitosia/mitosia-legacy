import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "@/lib/audit";
import { sourceIndex } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { INDEX_STALL_TTL_MINUTES } from "./window";

const REAP_BATCH_SIZE = 50;
const STALLED_ERROR = "Indexing stopped unexpectedly. Try again.";

// Same contract as the ingest/transcription/analysis reapers: "claims to be
// processing and nothing has written to the row for a whole stall window",
// evaluated in the database, scoped to processing only — pending is a
// legitimate queue state.
export const isStalledSourceIndex = and(
  eq(sourceIndex.status, "processing"),
  lt(
    sourceIndex.updatedAt,
    sql`now() - make_interval(mins => ${INDEX_STALL_TTL_MINUTES})`
  )
);

export async function reapStalledSourceIndexes(
  organizationId: string
): Promise<number> {
  const stalled = await withOrgScope(organizationId, (tx) =>
    tx
      .select({ id: sourceIndex.id, sourceId: sourceIndex.sourceId })
      .from(sourceIndex)
      .where(isStalledSourceIndex)
      .limit(REAP_BATCH_SIZE)
  );
  if (stalled.length === 0) {
    return 0;
  }

  await withOrgScope(organizationId, async (tx) => {
    await tx
      .update(sourceIndex)
      .set({ error: STALLED_ERROR, status: "failed" })
      .where(
        and(
          eq(sourceIndex.status, "processing"),
          inArray(
            sourceIndex.id,
            stalled.map((row) => row.id)
          )
        )
      );
    await Promise.all(
      stalled.map((row) =>
        recordAudit(tx, {
          action: "source_index.stalled",
          actorUserId: null,
          entityId: row.id,
          entityType: "source_index",
          metadata: {
            sourceId: row.sourceId,
            stallMinutes: INDEX_STALL_TTL_MINUTES,
          },
          organizationId,
        })
      )
    );
  });
  return stalled.length;
}

export function scheduleSourceIndexReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStalledSourceIndexes(organizationId);
      if (reaped > 0) {
        console.info(
          `[index] marked ${reaped} stalled index run(s) failed in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[index] stalled sweep failed:", error);
    }
  });
}
