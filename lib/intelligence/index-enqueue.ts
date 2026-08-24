import { sql } from "drizzle-orm";
import { after } from "next/server";
import { isEmbeddingConfigured } from "@/lib/ai/embeddings/provider";
import { sourceIndex } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import type { SourceIndexPayload } from "./index-pipeline";

// Single seam for kicking off source indexing, mirroring enqueueAnalysis.
// Unlike analysis, an index is re-runnable by design — every new transcript
// revision should re-embed — so the upsert flips ready/failed rows back to
// pending. Only "processing" is left alone: the running claim owns it.
export async function enqueueSourceIndex(
  payload: SourceIndexPayload
): Promise<void> {
  if (!isEmbeddingConfigured()) {
    return;
  }

  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .insert(sourceIndex)
      .values({
        organizationId: payload.organizationId,
        sourceId: payload.sourceId,
        status: "pending",
      })
      .onConflictDoUpdate({
        set: { error: null, status: "pending" },
        setWhere: sql`${sourceIndex.status} <> 'processing'`,
        target: sourceIndex.sourceId,
      })
  );

  if (process.env.TRIGGER_SECRET_KEY) {
    const { tasks } = await import("@trigger.dev/sdk");
    const { indexSourceTask } = await import("@/trigger/index-source");
    await tasks.trigger<typeof indexSourceTask>("index-source", payload, {
      concurrencyKey: payload.organizationId,
    });
    return;
  }

  const runInProcess = async () => {
    const { runSourceIndex } = await import("./index-pipeline");
    await runSourceIndex(payload);
  };
  runInProcess().catch((error) => {
    console.error(`[index] source ${payload.sourceId} failed:`, error);
  });
}

// Opportunistic backfill from the source page's render (the reaper-
// scheduling pattern): fired only when that page's own query saw a ready
// transcript with a missing or revision-stale index, so already-indexed
// sources cost nothing. This is also how pre-S5 sources get indexed — a
// visit does it, no script.
export function scheduleSourceIndexBackfill(payload: SourceIndexPayload): void {
  after(async () => {
    try {
      await enqueueSourceIndex(payload);
    } catch (error) {
      console.error("[index] backfill enqueue failed:", error);
    }
  });
}
