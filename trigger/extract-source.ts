import { task } from "@trigger.dev/sdk";
import { flushTelemetry, initAiTelemetry } from "@/lib/ai/telemetry";
import {
  type ExtractionPayload,
  runExtraction,
} from "@/lib/intelligence/extract-pipeline";
import { tuneOutboundConnections } from "@/lib/net-tuning";
import { isFinalAttempt } from "@/lib/trigger-attempts";

// Module scope, before the first query — the standing rule for every file
// under ./trigger (see trigger/ingest-source.ts).
tuneOutboundConnections();

// Durable wrapper around the extraction pipeline, shaped exactly like
// analyze-source: telemetry awaited in the per-run init hook (module-scope
// logs are invisible in run traces), failure state on the run row, rethrow
// so Trigger's retry policy governs, claimRun() makes retries idempotent.
export const extractSourceTask = task({
  id: "extract-source",
  init: async () => {
    await initAiTelemetry();
  },
  run: async (payload: ExtractionPayload, { ctx }) => {
    // Non-final attempts park failures back in the queue state so the
    // UI never shows a terminal error for a run Trigger is about to
    // retry (lib/trigger-attempts.ts).
    const finalAttempt = isFinalAttempt(ctx.attempt.number);
    try {
      await runExtraction(payload, { finalAttempt });
    } finally {
      await flushTelemetry();
    }
  },
});
