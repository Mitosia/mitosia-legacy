import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "@/lib/audit";
import { sourceExtractionRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { dispatchExtraction } from "./extract-enqueue";
import { EXTRACTION_STALL_TTL_MINUTES } from "./window";

const REAP_BATCH_SIZE = 50;
const STALLED_ERROR = "Extraction stopped unexpectedly. Try again.";

// Processing silence means the worker died. Pending silence means the
// durable intent may have been stranded between commit and dispatch (or the
// queue accepted an ambiguous request); CAS claim makes redispatch harmless.
const extractionSilentTooLong = lt(
  sourceExtractionRun.updatedAt,
  sql`now() - make_interval(mins => ${EXTRACTION_STALL_TTL_MINUTES})`
);

export const isStalledExtraction = and(
  or(
    eq(sourceExtractionRun.status, "pending"),
    eq(sourceExtractionRun.status, "processing")
  ),
  extractionSilentTooLong
);

export async function reapStalledExtractions(
  organizationId: string
): Promise<number> {
  const claimed = await withOrgScope(organizationId, async (tx) => {
    const stalled = await tx
      .select({
        id: sourceExtractionRun.id,
        sourceId: sourceExtractionRun.sourceId,
      })
      .from(sourceExtractionRun)
      .where(isStalledExtraction)
      .limit(REAP_BATCH_SIZE);
    if (stalled.length === 0) {
      return { pending: [], processing: [] };
    }
    const ids = stalled.map((row) => row.id);
    // Repeat the full silence predicate in both UPDATEs. A heartbeat or claim
    // between SELECT and UPDATE therefore wins the race.
    const processing = await tx
      .update(sourceExtractionRun)
      .set({ error: STALLED_ERROR, status: "failed" })
      .where(
        and(
          eq(sourceExtractionRun.status, "processing"),
          isStalledExtraction,
          inArray(sourceExtractionRun.id, ids)
        )
      )
      .returning({
        id: sourceExtractionRun.id,
        sourceId: sourceExtractionRun.sourceId,
      });
    const pending = await tx
      .update(sourceExtractionRun)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(sourceExtractionRun.status, "pending"),
          isStalledExtraction,
          inArray(sourceExtractionRun.id, ids)
        )
      )
      .returning({
        id: sourceExtractionRun.id,
        sourceId: sourceExtractionRun.sourceId,
      });
    await Promise.all(
      [
        ...processing.map((row) => ({
          action: "source_extraction.stalled",
          row,
        })),
        ...pending.map((row) => ({
          action: "source_extraction.redispatch_scheduled",
          row,
        })),
      ].map(({ action, row }) =>
        recordAudit(tx, {
          action,
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
    return { pending, processing };
  });
  const claimedCount = claimed.pending.length + claimed.processing.length;
  if (claimedCount === 0) {
    return 0;
  }

  const redispatched = await Promise.allSettled(
    claimed.pending.map((row) =>
      dispatchExtraction({ organizationId, sourceId: row.sourceId })
    )
  );
  for (const [index, result] of redispatched.entries()) {
    if (result.status === "rejected") {
      console.error(
        `[extract] stale pending redispatch failed for ${claimed.pending[index]?.sourceId}:`,
        result.reason
      );
    }
  }
  return claimedCount;
}

export function scheduleExtractionReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStalledExtractions(organizationId);
      if (reaped > 0) {
        console.info(
          `[extract] recovered or reaped ${reaped} stalled extraction run(s) in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[extract] stalled sweep failed:", error);
    }
  });
}
