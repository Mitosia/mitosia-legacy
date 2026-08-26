import { sql } from "drizzle-orm";
import { isAiConfigured } from "@/lib/ai/provider";
import { segmentPlanRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import type { SegmentPlanPayload } from "./segment-pipeline";

// Single seam for kicking off segment planning, the extract-enqueue clone.
// Deliberately NOT chained from any job: planning is a human's button (it
// heads toward spend-gated rendering), so the actions in
// lib/actions/segments.ts are the only callers.

function planningConfigured(): boolean {
  return isAiConfigured() || process.env.ANALYSIS_PROVIDER === "mock";
}

async function dispatch(payload: SegmentPlanPayload): Promise<void> {
  if (process.env.TRIGGER_SECRET_KEY) {
    const { tasks } = await import("@trigger.dev/sdk");
    const { planSegmentsTask } = await import("@/trigger/plan-segments");
    await tasks.trigger<typeof planSegmentsTask>("plan-segments", payload, {
      concurrencyKey: payload.organizationId,
    });
    return;
  }
  const runInProcess = async () => {
    const { runSegmentPlanPipeline } = await import("./segment-pipeline");
    await runSegmentPlanPipeline(payload);
  };
  runInProcess().catch((error) => {
    console.error(`[segments] source ${payload.sourceId} failed:`, error);
  });
}

// First plan (the "Plan segment clips" button): conflict-do-nothing — an
// existing row means a plan exists or a human is looking at a failure.
export async function enqueueSegmentPlan(
  payload: SegmentPlanPayload
): Promise<void> {
  if (!planningConfigured()) {
    return;
  }
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .insert(segmentPlanRun)
      .values({
        organizationId: payload.organizationId,
        sourceId: payload.sourceId,
        status: "pending",
      })
      .onConflictDoNothing({ target: segmentPlanRun.sourceId })
  );
  await dispatch(payload);
}

// The human re-plan: flips ready/failed back to pending. The ACTION layer
// guards this with the decided-rows refusal (re-plans delete-and-replace,
// and decided rows are the review record).
export async function enqueueSegmentPlanRerun(
  payload: SegmentPlanPayload
): Promise<void> {
  if (!planningConfigured()) {
    return;
  }
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .insert(segmentPlanRun)
      .values({
        organizationId: payload.organizationId,
        sourceId: payload.sourceId,
        status: "pending",
      })
      .onConflictDoUpdate({
        set: { error: null, status: "pending" },
        setWhere: sql`${segmentPlanRun.status} <> 'processing'`,
        target: segmentPlanRun.sourceId,
      })
  );
  await dispatch(payload);
}
