import { task } from "@trigger.dev/sdk";
import {
  runSourceIndex,
  type SourceIndexPayload,
} from "@/lib/intelligence/index-pipeline";
import { tuneOutboundConnections } from "@/lib/net-tuning";

// Module scope, before the first query — the standing rule for every file
// under ./trigger (see trigger/ingest-source.ts).
tuneOutboundConnections();

// Durable wrapper around the index pipeline. Failure state lands on the
// source_index row and rethrows so Trigger's retry policy governs;
// claimIndex() makes retries idempotent. No machine override and no AI SDK
// telemetry init — embedding is a plain HTTP call, not a generation.
export const indexSourceTask = task({
  id: "index-source",
  run: async (payload: SourceIndexPayload) => {
    await runSourceIndex(payload);
  },
});
