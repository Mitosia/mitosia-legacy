import { task } from "@trigger.dev/sdk";
import { initAiTelemetry } from "@/lib/ai/telemetry";
import { type AnalysisPayload, runAnalysis } from "@/lib/analysis/pipeline";
import { tuneOutboundConnections } from "@/lib/net-tuning";

// Module scope, before the first query — the standing rule for every file
// under ./trigger (see trigger/ingest-source.ts). Telemetry follows the
// same pattern: Next's register() never fires here.
tuneOutboundConnections();

// Durable wrapper around the analysis pipeline. Failure state lands on the
// source_analysis row and rethrows so Trigger's retry policy governs;
// claimAnalysis() makes retries idempotent. No machine override — two
// structured-output calls, the provider does the work.
//
// Telemetry init is AWAITED in the per-run init hook, not fired at module
// scope: the hook guarantees the AI SDK telemetry integration is
// registered before the first generation, and anything it logs lands in
// the RUN's log stream where it can actually be read (module-scope
// console output in workers is invisible in run traces — learned while
// chasing missing generation spans).
export const analyzeSourceTask = task({
  id: "analyze-source",
  init: async () => {
    await initAiTelemetry();
  },
  run: async (payload: AnalysisPayload) => {
    await runAnalysis(payload);
  },
});
