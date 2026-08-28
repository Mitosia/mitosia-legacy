import { task } from "@trigger.dev/sdk";
import { flushTelemetry, initAiTelemetry } from "@/lib/ai/telemetry";
import {
  type DiscoveryPayload,
  runDiscovery,
} from "@/lib/intelligence/discover-pipeline";
import { tuneOutboundConnections } from "@/lib/net-tuning";
import { isFinalAttempt } from "@/lib/trigger-attempts";

// Module scope, before the first query — the standing rule for every file
// under ./trigger (see trigger/ingest-source.ts).
tuneOutboundConnections();

// Durable wrapper around the discovery pipeline, shaped exactly like
// extract-source: telemetry awaited in the per-run init hook, failure state
// on the run row, rethrow so Trigger's retry policy governs. The payload's
// dispatch lease plus claimRun's attempt CAS make retries idempotent and make
// delayed tasks from an older human re-run harmless.
export const discoverMomentsTask = task({
  id: "discover-moments",
  init: async () => {
    await initAiTelemetry();
  },
  run: async (payload: DiscoveryPayload, { ctx }) => {
    // Non-final attempts park failures back in the queue state so the
    // UI never shows a terminal error for a run Trigger is about to
    // retry (lib/trigger-attempts.ts).
    const finalAttempt = isFinalAttempt(ctx.attempt.number);
    try {
      await runDiscovery(payload, { finalAttempt });
    } finally {
      await flushTelemetry();
    }
  },
});
