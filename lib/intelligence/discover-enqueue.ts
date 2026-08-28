import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { isAiConfigured } from "@/lib/ai/provider";
import { momentDiscoveryRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import type { DiscoveryPayload } from "./discover-pipeline";
import { terminalDiscoveryFailureStatus } from "./discovery-state";

// Single seam for kicking off moment discovery. The durable intent is always
// committed before the external dispatch: if the process dies in that gap,
// discover-reaper.ts can recover only the explicitly-undispatched pending row.

const DISCOVERY_DISPATCH_ERROR =
  "Moment discovery could not be queued. Try again.";

export function discoveryConfigured(): boolean {
  return isAiConfigured() || process.env.ANALYSIS_PROVIDER === "mock";
}

export async function dispatchDiscovery(
  payload: DiscoveryPayload
): Promise<string> {
  if (process.env.TRIGGER_SECRET_KEY) {
    const { tasks } = await import("@trigger.dev/sdk");
    const { discoverMomentsTask } = await import("@/trigger/discover-moments");
    const handle = await tasks.trigger<typeof discoverMomentsTask>(
      "discover-moments",
      payload,
      { concurrencyKey: payload.organizationId }
    );
    return handle.id;
  }
  const runInProcess = async () => {
    const { runDiscovery } = await import("./discover-pipeline");
    await runDiscovery(payload);
  };
  runInProcess().catch((error) => {
    console.error(`[discover] source ${payload.sourceId} failed:`, error);
  });
  return "in-process";
}

interface DiscoveryRequest {
  organizationId: string;
  sourceId: string;
}

// The automatic chain from extraction success is first-run only. An existing
// lifecycle row means discovery already ran (or a human is inspecting a
// failure), so it must not spend again. Only the transaction that actually
// creates the pending intent is allowed to dispatch it.
export async function enqueueDiscovery(
  request: DiscoveryRequest
): Promise<void> {
  if (!discoveryConfigured()) {
    return;
  }
  const dispatchLease = randomUUID();
  const [created] = await withOrgScope(request.organizationId, (tx) =>
    tx
      .insert(momentDiscoveryRun)
      .values({
        counts: { dispatchLease, dispatchState: "pending" },
        organizationId: request.organizationId,
        sourceId: request.sourceId,
        status: "pending",
      })
      .onConflictDoNothing({ target: momentDiscoveryRun.sourceId })
      .returning({ id: momentDiscoveryRun.id })
  );
  if (!created) {
    return;
  }

  try {
    const dispatchId = await dispatchDiscovery({
      dispatchLease,
      organizationId: request.organizationId,
      sourceId: request.sourceId,
    });
    await withOrgScope(request.organizationId, (tx) =>
      tx
        .update(momentDiscoveryRun)
        .set({
          counts: sql`COALESCE(${momentDiscoveryRun.counts}, '{}'::jsonb) || jsonb_build_object(
            'dispatchedAt', ${new Date().toISOString()}::text,
            'dispatchId', ${dispatchId}::text,
            'dispatchLease', ${dispatchLease}::text,
            'dispatchState', 'confirmed'
          )`,
        })
        .where(
          and(
            eq(momentDiscoveryRun.id, created.id),
            sql`${momentDiscoveryRun.counts}->>'dispatchLease' = ${dispatchLease}`,
            eq(momentDiscoveryRun.status, "pending")
          )
        )
    );
  } catch (error) {
    console.error(
      `[discover] could not dispatch source ${request.sourceId}:`,
      error
    );
    await withOrgScope(request.organizationId, (tx) =>
      tx
        .update(momentDiscoveryRun)
        .set({
          error: DISCOVERY_DISPATCH_ERROR,
          status: terminalDiscoveryFailureStatus,
        })
        .where(
          and(
            eq(momentDiscoveryRun.id, created.id),
            sql`${momentDiscoveryRun.counts}->>'dispatchLease' = ${dispatchLease}`,
            eq(momentDiscoveryRun.status, "pending")
          )
        )
    );
  }
}
