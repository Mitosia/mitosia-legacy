import { task } from "@trigger.dev/sdk";
import { flushTelemetry, initAiTelemetry } from "@/lib/ai/telemetry";
import {
  type DiscoveryPayload,
  runDiscovery,
} from "@/lib/intelligence/discover-pipeline";
import { tuneOutboundConnections } from "@/lib/net-tuning";

// Module scope, before the first query — the standing rule for every file
// under ./trigger (see trigger/ingest-source.ts).
tuneOutboundConnections();

// Durable wrapper around the discovery pipeline, shaped exactly like
// extract-source: telemetry awaited in the per-run init hook, failure state
// on the run row, rethrow so Trigger's retry policy governs, claimRun()
// makes retries idempotent.
export const discoverMomentsTask = task({
  id: "discover-moments",
  init: async () => {
    await initAiTelemetry();
  },
  run: async (payload: DiscoveryPayload) => {
    try {
      await runDiscovery(payload);
    } finally {
      await flushTelemetry();
    }
  },
});
