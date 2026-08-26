import { task } from "@trigger.dev/sdk";
import { flushTelemetry, initAiTelemetry } from "@/lib/ai/telemetry";
import {
  runSegmentPlanPipeline,
  type SegmentPlanPayload,
} from "@/lib/intelligence/segment-pipeline";
import { tuneOutboundConnections } from "@/lib/net-tuning";
import { isFinalAttempt } from "@/lib/trigger-attempts";

// Module scope, before the first query — the standing rule for every file
// under ./trigger (see trigger/ingest-source.ts).
tuneOutboundConnections();

// Durable wrapper around the segment-plan pipeline, shaped exactly like
// discover-moments: telemetry in the init hook, attempt-aware failure
// recording, rethrow so Trigger's retry policy governs.
export const planSegmentsTask = task({
  id: "plan-segments",
  init: async () => {
    await initAiTelemetry();
  },
  run: async (payload: SegmentPlanPayload, { ctx }) => {
    // Non-final attempts park failures back in the queue state so the
    // UI never shows a terminal error for a run Trigger is about to
    // retry (lib/trigger-attempts.ts).
    const finalAttempt = isFinalAttempt(ctx.attempt.number);
    try {
      await runSegmentPlanPipeline(payload, { finalAttempt });
    } finally {
      await flushTelemetry();
    }
  },
});
