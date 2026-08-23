import { isAiConfigured } from "@/lib/ai/provider";
import { sourceAnalysis } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import type { AnalysisPayload } from "./pipeline";

// Single seam for kicking off source analysis, mirroring
// enqueueTranscription: pending row first (idempotent via the unique
// source_id index), then the Trigger task or the in-process dev fallback.
// Unconfigured environments (no AI keys, no mock) get no row at all —
// absence is the "not configured" signal.
export async function enqueueAnalysis(payload: AnalysisPayload): Promise<void> {
  if (!(isAiConfigured() || process.env.ANALYSIS_PROVIDER === "mock")) {
    return;
  }

  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .insert(sourceAnalysis)
      .values({
        organizationId: payload.organizationId,
        sourceId: payload.sourceId,
        status: "pending",
      })
      .onConflictDoNothing({ target: sourceAnalysis.sourceId })
  );

  if (process.env.TRIGGER_SECRET_KEY) {
    const { tasks } = await import("@trigger.dev/sdk");
    const { analyzeSourceTask } = await import("@/trigger/analyze-source");
    await tasks.trigger<typeof analyzeSourceTask>("analyze-source", payload, {
      concurrencyKey: payload.organizationId,
    });
    return;
  }

  const runInProcess = async () => {
    const { runAnalysis } = await import("./pipeline");
    await runAnalysis(payload);
  };
  runInProcess().catch((error) => {
    console.error(`[analysis] source ${payload.sourceId} failed:`, error);
  });
}
