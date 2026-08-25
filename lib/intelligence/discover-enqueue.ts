import { sql } from "drizzle-orm";
import { isAiConfigured } from "@/lib/ai/provider";
import { momentDiscoveryRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import type { DiscoveryPayload } from "./discover-pipeline";

// Single seam for kicking off moment discovery, the extract-enqueue clone:
// gated on the same AI configuration (discovery shares
// ANALYSIS_PROVIDER=mock), pending row first, then the Trigger task or the
// in-process dev fallback.

function discoveryConfigured(): boolean {
  return isAiConfigured() || process.env.ANALYSIS_PROVIDER === "mock";
}

async function dispatch(payload: DiscoveryPayload): Promise<void> {
  if (process.env.TRIGGER_SECRET_KEY) {
    const { tasks } = await import("@trigger.dev/sdk");
    const { discoverMomentsTask } = await import("@/trigger/discover-moments");
    await tasks.trigger<typeof discoverMomentsTask>(
      "discover-moments",
      payload,
      { concurrencyKey: payload.organizationId }
    );
    return;
  }
  const runInProcess = async () => {
    const { runDiscovery } = await import("./discover-pipeline");
    await runDiscovery(payload);
  };
  runInProcess().catch((error) => {
    console.error(`[discover] source ${payload.sourceId} failed:`, error);
  });
}

// The automatic chain (from extraction success): first run only — an
// existing row means the source already discovered (or a human is looking
// at a failure) and re-running costs real model spend.
export async function enqueueDiscovery(
  payload: DiscoveryPayload
): Promise<void> {
  if (!discoveryConfigured()) {
    return;
  }
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .insert(momentDiscoveryRun)
      .values({
        organizationId: payload.organizationId,
        sourceId: payload.sourceId,
        status: "pending",
      })
      .onConflictDoNothing({ target: momentDiscoveryRun.sourceId })
  );
  await dispatch(payload);
}

// The human action (retry after failure, re-discover after corrections):
// flips ready/failed back to pending. Only "processing" is left alone.
// The ACTION layer guards this with the decided-rows refusal (re-runs
// delete-and-replace candidates, and decided rows are the M1 record).
export async function enqueueDiscoveryRerun(
  payload: DiscoveryPayload
): Promise<void> {
  if (!discoveryConfigured()) {
    return;
  }
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .insert(momentDiscoveryRun)
      .values({
        organizationId: payload.organizationId,
        sourceId: payload.sourceId,
        status: "pending",
      })
      .onConflictDoUpdate({
        set: { error: null, status: "pending" },
        setWhere: sql`${momentDiscoveryRun.status} <> 'processing'`,
        target: momentDiscoveryRun.sourceId,
      })
  );
  await dispatch(payload);
}
