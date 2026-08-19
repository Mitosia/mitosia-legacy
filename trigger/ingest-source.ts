import { task } from "@trigger.dev/sdk";
import { type IngestPayload, runIngestPipeline } from "@/lib/media/pipeline";
import { tuneOutboundConnections } from "@/lib/net-tuning";

// Third entrypoint that opens a database connection, after instrumentation.ts
// and scripts/migrate.ts — and the only one Next.js does not start, so its
// `register()` hook never runs here. Without this call Node gives each
// resolved Neon address 250ms before moving on, and Neon publishes AAAA
// records a worker may have no route to; every address fails in under a
// second and `pg` throws a bare AggregateError with nothing pointing at DNS.
//
// Module scope, not inside run(): it must precede the first query, and the pg
// Pool is constructed at import but does not connect until one is issued.
// Any further task file added to ./trigger needs the same call.
tuneOutboundConnections();

// Durable wrapper around the ingest pipeline. The pipeline records failure
// state on the source row itself and then rethrows, so Trigger.dev's retry
// policy (trigger.config.ts) governs re-runs; claimSource() makes retries
// idempotent — a run that lost the claim simply no-ops.
export const ingestSourceTask = task({
  id: "ingest-source",
  // Trigger's default preset is small-1x — 0.5 vCPU and 0.5 GB. The HLS
  // ladder runs ffmpeg over three renditions and does not fit: the first
  // real run was OOM-killed (TASK_PROCESS_OOM_KILLED) on a *small* test
  // file, after five minutes of thrashing that wrote no progress at all.
  //
  // large-1x is 4 vCPU / 8 GB. The memory is headroom; the vCPUs are the
  // point, because the ladder is CPU-bound (~0.26x realtime on the 8-vCPU
  // VPS) and Trigger bills by the second — a machine that is 2x faster on
  // CPU-bound work costs about the same in total and halves the wall clock.
  machine: "large-1x",
  run: async (payload: IngestPayload) => {
    await runIngestPipeline(payload);
  },
});
