import { eq } from "drizzle-orm";
import { estimateEmbeddingCostUsd } from "@/lib/ai/config";
import { getEmbeddingProvider } from "@/lib/ai/embeddings/provider";
import { sourceIndex, transcriptChunk } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { recordUsage } from "@/lib/ledger";
import { sanitizeIngestError } from "@/lib/media/ingest-error";
import { loadCurrentTranscript } from "@/lib/transcription/store";
import { buildChunks } from "./chunks";

// The S5 index workflow: claim → chunk the current transcript revision →
// embed → transactionally replace the chunk set + metering. Mirrors
// lib/analysis/pipeline.ts exactly: same claim contract, same failure
// recording, runs under Trigger or the in-process dev fallback. Only the
// CURRENT revision's chunks are kept — re-embedding after a correction is
// fractions of a cent, so search never serves corrected-away words.

const INDEX_ERROR_MAX_CHARS = 2000;

export interface SourceIndexPayload {
  organizationId: string;
  sourceId: string;
}

interface ClaimedIndex {
  attempt: number;
  indexId: string;
}

async function claimIndex(
  payload: SourceIndexPayload
): Promise<ClaimedIndex | null> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [existing] = await tx
      .select({
        attempts: sourceIndex.attempts,
        id: sourceIndex.id,
        status: sourceIndex.status,
      })
      .from(sourceIndex)
      .where(eq(sourceIndex.sourceId, payload.sourceId))
      .limit(1);

    if (!existing) {
      const [created] = await tx
        .insert(sourceIndex)
        .values({
          attempts: 1,
          organizationId: payload.organizationId,
          sourceId: payload.sourceId,
          status: "processing",
        })
        .onConflictDoNothing({ target: sourceIndex.sourceId })
        .returning({ id: sourceIndex.id });
      return created ? { attempt: 1, indexId: created.id } : null;
    }
    if (existing.status === "processing" || existing.status === "ready") {
      return null;
    }
    await tx
      .update(sourceIndex)
      .set({
        attempts: existing.attempts + 1,
        error: null,
        status: "processing",
      })
      .where(eq(sourceIndex.id, existing.id));
    return { attempt: existing.attempts + 1, indexId: existing.id };
  });
}

async function recordIndexFailure(
  payload: SourceIndexPayload,
  indexId: string,
  error: unknown
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown indexing failure";
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(sourceIndex)
      .set({
        error: sanitizeIngestError(message).slice(0, INDEX_ERROR_MAX_CHARS),
        status: "failed",
      })
      .where(eq(sourceIndex.id, indexId))
  );
}

export async function runSourceIndex(
  payload: SourceIndexPayload
): Promise<void> {
  const claimed = await claimIndex(payload);
  if (!claimed) {
    return;
  }

  try {
    const provider = getEmbeddingProvider();
    if (!provider) {
      throw new Error(
        "No embedding provider configured (set VOYAGE_API_KEY or EMBEDDING_PROVIDER)"
      );
    }

    const transcript = await loadCurrentTranscript(
      payload.organizationId,
      payload.sourceId
    );
    if (!transcript) {
      throw new Error("Source has no ready transcript to index");
    }

    const chunks = buildChunks(transcript.data);
    const embedded =
      chunks.length > 0
        ? await provider.embed(
            chunks.map((chunk) => chunk.text),
            "document"
          )
        : { model: null, tokens: 0, vectors: [] as number[][] };

    await withOrgScope(payload.organizationId, async (tx) => {
      // Re-runs replace: the chunk set belongs to exactly one revision.
      await tx
        .delete(transcriptChunk)
        .where(eq(transcriptChunk.sourceId, payload.sourceId));
      if (chunks.length > 0 && embedded.model) {
        await tx.insert(transcriptChunk).values(
          chunks.map((chunk, position) => {
            const embedding = embedded.vectors[position];
            if (!embedding) {
              throw new Error(
                `Embedding missing for chunk ${position} of ${chunks.length}`
              );
            }
            return {
              embedding,
              embeddingModel: embedded.model as string,
              endMs: chunk.endMs,
              idx: chunk.idx,
              organizationId: payload.organizationId,
              revision: transcript.revision,
              sourceId: payload.sourceId,
              speakers: chunk.speakers,
              startMs: chunk.startMs,
              text: chunk.text,
              tokenCount: chunk.tokenCount,
            };
          })
        );
      }

      await tx
        .update(sourceIndex)
        .set({
          chunkCount: chunks.length,
          embeddingModel: embedded.model,
          error: null,
          revision: transcript.revision,
          status: "ready",
        })
        .where(eq(sourceIndex.id, claimed.indexId));

      // Metering (cross-cutting rule 1): embeddings are ai_tokens like the
      // analysis calls, distinguished by kind + provider in metadata.
      if (embedded.model && embedded.tokens > 0) {
        await recordUsage(tx, {
          correlationId: `index:${payload.sourceId}:rev${transcript.revision}:${claimed.attempt}`,
          entryType: "ai_tokens",
          metadata: {
            costUsd: estimateEmbeddingCostUsd(embedded.model, embedded.tokens),
            inputTokens: embedded.tokens,
            kind: "embedding",
            model: embedded.model,
            provider: provider.name,
            revision: transcript.revision,
          },
          organizationId: payload.organizationId,
          quantity: embedded.tokens,
          sourceId: payload.sourceId,
          unit: "tokens",
        });
      }
    });
  } catch (error) {
    await recordIndexFailure(payload, claimed.indexId, error);
    throw error;
  }
}
