import { task } from "@trigger.dev/sdk";
import { type IngestPayload, runIngestPipeline } from "@/lib/media/pipeline";

// Durable wrapper around the ingest pipeline. The pipeline records failure
// state on the source row itself and then rethrows, so Trigger.dev's retry
// policy (trigger.config.ts) governs re-runs; claimSource() makes retries
// idempotent — a run that lost the claim simply no-ops.
export const ingestSourceTask = task({
  id: "ingest-source",
  run: async (payload: IngestPayload) => {
    await runIngestPipeline(payload);
  },
});
