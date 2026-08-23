import { task } from "@trigger.dev/sdk";
import { initAiTelemetry } from "@/lib/ai/telemetry";
import { type AnalysisPayload, runAnalysis } from "@/lib/analysis/pipeline";
import { tuneOutboundConnections } from "@/lib/net-tuning";

// Module scope, before the first query — the standing rule for every file
// under ./trigger (see trigger/ingest-source.ts). Telemetry follows the
// same pattern: Next's register() never fires here.
tuneOutboundConnections();
initAiTelemetry().catch((error) => {
  console.error("[analyze-source] telemetry init failed:", error);
});

// Durable wrapper around the analysis pipeline. Failure state lands on the
// source_analysis row and rethrows so Trigger's retry policy governs;
// claimAnalysis() makes retries idempotent. No machine override — two
// structured-output calls, the provider does the work.
export const analyzeSourceTask = task({
  id: "analyze-source",
  run: async (payload: AnalysisPayload) => {
    await runAnalysis(payload);
  },
});
