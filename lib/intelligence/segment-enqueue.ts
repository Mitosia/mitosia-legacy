import { isAiConfigured } from "@/lib/ai/provider";
import type { SegmentPlanPayload } from "./segment-pipeline";

// Single seam for kicking off segment planning, the extract-enqueue clone.
// Deliberately NOT chained from any job: planning is a human's button (it
// heads toward spend-gated rendering), so the actions in
// lib/actions/segments.ts are the only callers.

export function segmentPlanningConfigured(): boolean {
  return isAiConfigured() || process.env.ANALYSIS_PROVIDER === "mock";
}

export async function dispatchSegmentPlan(
  payload: SegmentPlanPayload
): Promise<string> {
  if (process.env.TRIGGER_SECRET_KEY) {
    const { tasks } = await import("@trigger.dev/sdk");
    const { planSegmentsTask } = await import("@/trigger/plan-segments");
    const handle = await tasks.trigger<typeof planSegmentsTask>(
      "plan-segments",
      payload,
      {
        concurrencyKey: payload.organizationId,
      }
    );
    return handle.id;
  }
  const runInProcess = async () => {
    const { runSegmentPlanPipeline } = await import("./segment-pipeline");
    await runSegmentPlanPipeline(payload);
  };
  runInProcess().catch((error) => {
    console.error(`[segments] source ${payload.sourceId} failed:`, error);
  });
  return "in-process";
}
