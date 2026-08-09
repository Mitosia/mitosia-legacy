import { after } from "next/server";
import type { IngestPayload } from "./media/pipeline";

// Single seam for kicking off ingest. With TRIGGER_SECRET_KEY set the
// durable Trigger.dev task runs it (staging/prod); without it the pipeline
// runs in-process after the response flushes — a dev fallback with real
// limitations (dies with the dev server, no retry backoff). The pipeline
// claim step makes double-enqueues harmless either way.
export async function enqueueIngest(payload: IngestPayload): Promise<void> {
  if (process.env.TRIGGER_SECRET_KEY) {
    const { tasks } = await import("@trigger.dev/sdk");
    const { ingestSourceTask } = await import("@/trigger/ingest-source");
    await tasks.trigger<typeof ingestSourceTask>("ingest-source", payload, {
      // Per-org fairness: one tenant's bulk upload cannot starve another.
      concurrencyKey: payload.organizationId,
    });
    return;
  }

  after(async () => {
    const { runIngestPipeline } = await import("./media/pipeline");
    try {
      await runIngestPipeline(payload);
    } catch (error) {
      // Failure state is already on the source row (recordFailure); this
      // log is for the dev console only.
      console.error(`[ingest] source ${payload.sourceId} failed:`, error);
    }
  });
}
