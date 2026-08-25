import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "@/lib/audit";
import { momentDiscoveryRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { DISCOVERY_STALL_TTL_MINUTES } from "./window";

const REAP_BATCH_SIZE = 50;
const STALLED_ERROR = "Moment discovery stopped unexpectedly. Try again.";

// Same contract as the extraction reaper: "claims to be processing and
// nothing has written to the row for a whole stall window", evaluated in
// the database, scoped to processing only.
export const isStalledDiscovery = and(
  eq(momentDiscoveryRun.status, "processing"),
  lt(
    momentDiscoveryRun.updatedAt,
    sql`now() - make_interval(mins => ${DISCOVERY_STALL_TTL_MINUTES})`
  )
);

export async function reapStalledDiscoveries(
  organizationId: string
): Promise<number> {
  const stalled = await withOrgScope(organizationId, (tx) =>
    tx
      .select({
        id: momentDiscoveryRun.id,
        sourceId: momentDiscoveryRun.sourceId,
      })
      .from(momentDiscoveryRun)
      .where(isStalledDiscovery)
      .limit(REAP_BATCH_SIZE)
  );
  if (stalled.length === 0) {
    return 0;
  }

  await withOrgScope(organizationId, async (tx) => {
    await tx
      .update(momentDiscoveryRun)
      .set({ error: STALLED_ERROR, status: "failed" })
      .where(
        and(
          eq(momentDiscoveryRun.status, "processing"),
          inArray(
            momentDiscoveryRun.id,
            stalled.map((row) => row.id)
          )
        )
      );
    await Promise.all(
      stalled.map((row) =>
        recordAudit(tx, {
          action: "moment_discovery.stalled",
          actorUserId: null,
          entityId: row.id,
          entityType: "moment_discovery_run",
          metadata: {
            sourceId: row.sourceId,
            stallMinutes: DISCOVERY_STALL_TTL_MINUTES,
          },
          organizationId,
        })
      )
    );
  });
  return stalled.length;
}

export function scheduleDiscoveryReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStalledDiscoveries(organizationId);
      if (reaped > 0) {
        console.info(
          `[discover] marked ${reaped} stalled discovery run(s) failed in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[discover] stalled sweep failed:", error);
    }
  });
}
