import { sql } from "drizzle-orm";
import { isAiConfigured } from "@/lib/ai/provider";
import { sourceExtractionRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import type { ExtractionPayload } from "./extract-pipeline";

// Single seam for kicking off extraction, mirroring enqueueAnalysis: gated
// on the same AI configuration (extraction is the analysis capability's
// sibling and shares ANALYSIS_PROVIDER=mock), pending row first, then the
// Trigger task or the in-process dev fallback.

function extractionConfigured(): boolean {
  return isAiConfigured() || process.env.ANALYSIS_PROVIDER === "mock";
}

async function dispatch(payload: ExtractionPayload): Promise<void> {
  if (process.env.TRIGGER_SECRET_KEY) {
    const { tasks } = await import("@trigger.dev/sdk");
    const { extractSourceTask } = await import("@/trigger/extract-source");
    await tasks.trigger<typeof extractSourceTask>("extract-source", payload, {
      concurrencyKey: payload.organizationId,
    });
    return;
  }
  const runInProcess = async () => {
    const { runExtraction } = await import("./extract-pipeline");
    await runExtraction(payload);
  };
  runInProcess().catch((error) => {
    console.error(`[extract] source ${payload.sourceId} failed:`, error);
  });
}

// The automatic chain (from analysis success): first run only — an existing
// row means the source already extracted (or a human is looking at a
// failure) and re-running costs real model spend.
export async function enqueueExtraction(
  payload: ExtractionPayload
): Promise<void> {
  if (!extractionConfigured()) {
    return;
  }
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .insert(sourceExtractionRun)
      .values({
        organizationId: payload.organizationId,
        sourceId: payload.sourceId,
        status: "pending",
      })
      .onConflictDoNothing({ target: sourceExtractionRun.sourceId })
  );
  await dispatch(payload);
}

// The human action (retry after failure, re-extract after corrections):
// flips ready/failed back to pending. Only "processing" is left alone.
export async function enqueueExtractionRerun(
  payload: ExtractionPayload
): Promise<void> {
  if (!extractionConfigured()) {
    return;
  }
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .insert(sourceExtractionRun)
      .values({
        organizationId: payload.organizationId,
        sourceId: payload.sourceId,
        status: "pending",
      })
      .onConflictDoUpdate({
        set: { error: null, status: "pending" },
        setWhere: sql`${sourceExtractionRun.status} <> 'processing'`,
        target: sourceExtractionRun.sourceId,
      })
  );
  await dispatch(payload);
}
