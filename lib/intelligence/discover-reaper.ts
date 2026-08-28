import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "@/lib/audit";
import { momentDiscoveryRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { dispatchDiscovery } from "./discover-enqueue";
import { terminalDiscoveryFailureStatus } from "./discovery-state";
import { DISCOVERY_STALL_TTL_MINUTES } from "./window";

const REAP_BATCH_SIZE = 50;
const STALLED_ERROR = "Moment discovery stopped unexpectedly. Try again.";
const REDISPATCH_ERROR = "Moment discovery could not be re-queued. Try again.";

// Processing silence means the worker died. Pending silence is recoverable
// only when the durable intent still says dispatch never completed. A
// confirmed Trigger queue may wait legitimately and must never be duplicated.
const discoverySilentTooLong = lt(
  momentDiscoveryRun.updatedAt,
  sql`now() - make_interval(mins => ${DISCOVERY_STALL_TTL_MINUTES})`
);

export const isStalledDiscovery = or(
  and(eq(momentDiscoveryRun.status, "processing"), discoverySilentTooLong),
  and(
    eq(momentDiscoveryRun.status, "pending"),
    sql`${momentDiscoveryRun.counts}->>'dispatchState' = 'pending'`,
    discoverySilentTooLong
  )
);

function stalledAuditAction(status: string): string {
  if (status === "pending") {
    return "moment_discovery.redispatch_scheduled";
  }
  return status === "ready"
    ? "moment_discovery.refresh_stalled_preserved"
    : "moment_discovery.stalled";
}

export async function reapStalledDiscoveries(
  organizationId: string
): Promise<number> {
  const dispatchLease = randomUUID();
  const claimed = await withOrgScope(organizationId, async (tx) => {
    const candidates = await tx
      .select({
        id: momentDiscoveryRun.id,
        sourceId: momentDiscoveryRun.sourceId,
        status: momentDiscoveryRun.status,
      })
      .from(momentDiscoveryRun)
      .where(isStalledDiscovery)
      .limit(REAP_BATCH_SIZE);
    if (candidates.length === 0) {
      return { pending: [], processing: [] };
    }
    const candidateIds = candidates.map((row) => row.id);
    // Repeat the full silence predicate in each UPDATE. A heartbeat or a new
    // dispatch intent between SELECT and UPDATE therefore wins the race.
    const processing = await tx
      .update(momentDiscoveryRun)
      .set({ error: STALLED_ERROR, status: terminalDiscoveryFailureStatus })
      .where(
        and(
          eq(momentDiscoveryRun.status, "processing"),
          isStalledDiscovery,
          inArray(momentDiscoveryRun.id, candidateIds)
        )
      )
      .returning({
        id: momentDiscoveryRun.id,
        sourceId: momentDiscoveryRun.sourceId,
        status: momentDiscoveryRun.status,
      });
    const pending = await tx
      .update(momentDiscoveryRun)
      .set({
        counts: sql`(
          COALESCE(${momentDiscoveryRun.counts}, '{}'::jsonb)
          - 'stage' - 'dispatchId' - 'dispatchedAt'
        ) || jsonb_build_object(
          'dispatchLease', ${dispatchLease}::text,
          'dispatchState', 'pending'
        )`,
      })
      .where(
        and(
          eq(momentDiscoveryRun.status, "pending"),
          isStalledDiscovery,
          inArray(momentDiscoveryRun.id, candidateIds)
        )
      )
      .returning({
        id: momentDiscoveryRun.id,
        sourceId: momentDiscoveryRun.sourceId,
        status: momentDiscoveryRun.status,
      });
    await Promise.all(
      [...processing, ...pending].map((row) =>
        recordAudit(tx, {
          action: stalledAuditAction(row.status),
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
      dispatchDiscovery({
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
            .update(momentDiscoveryRun)
            .set({
              counts: sql`COALESCE(${momentDiscoveryRun.counts}, '{}'::jsonb) || jsonb_build_object(
                'dispatchedAt', ${new Date().toISOString()}::text,
                'dispatchId', ${dispatchId}::text,
                'dispatchLease', ${row.dispatchLease}::text,
                'dispatchState', 'confirmed'
              )`,
            })
            .where(
              and(
                eq(momentDiscoveryRun.id, row.id),
                sql`${momentDiscoveryRun.counts}->>'dispatchLease' = ${row.dispatchLease}`,
                eq(momentDiscoveryRun.status, "pending")
              )
            )
            .returning({ id: momentDiscoveryRun.id });
          return updated
            ? recordAudit(tx, {
                action: "moment_discovery.redispatched",
                actorUserId: null,
                entityId: updated.id,
                entityType: "moment_discovery_run",
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
        .update(momentDiscoveryRun)
        .set({
          error: REDISPATCH_ERROR,
          status: terminalDiscoveryFailureStatus,
        })
        .where(
          and(
            eq(momentDiscoveryRun.status, "pending"),
            sql`${momentDiscoveryRun.counts}->>'dispatchLease' = ${dispatchLease}`,
            inArray(momentDiscoveryRun.id, failedIds)
          )
        )
        .returning({
          id: momentDiscoveryRun.id,
          status: momentDiscoveryRun.status,
        });
      await Promise.all(
        failed.map(({ id, status }) =>
          recordAudit(tx, {
            action:
              status === "ready"
                ? "moment_discovery.redispatch_failed_preserved"
                : "moment_discovery.redispatch_failed",
            actorUserId: null,
            entityId: id,
            entityType: "moment_discovery_run",
            organizationId,
          })
        )
      );
    });
  }
  return claimedCount;
}

export function scheduleDiscoveryReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStalledDiscoveries(organizationId);
      if (reaped > 0) {
        console.info(
          `[discover] recovered or reaped ${reaped} stalled discovery run(s) in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[discover] stalled sweep failed:", error);
    }
  });
}
