import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "@/lib/db/schema/intelligence";
import type {
  EmbeddingInputType,
  EmbeddingProvider,
  EmbeddingResult,
} from "./types";

// Voyage adapter (decision 2026-08-24, superseding tech-stack §7's
// voyage-3-large): voyage-4 is the recommended general-purpose tier —
// $0.06/M tokens, 200M free tokens per account, 1024-dim default. Plain
// REST behind our own seam; no SDK dependency for one endpoint. The raw
// response is parsed with our own zod schema (the Deepgram-adapter
// precedent): a failed parse is a loud provider-contract alarm, never a
// silent shape drift.

export const VOYAGE_MODEL = "voyage-4";

// Voyage caps a request at 128 inputs (and a token budget far above what
// 128 transcript chunks reach). Batches run sequentially — order maps
// straight back to input order.
const MAX_BATCH_INPUTS = 128;

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const ERROR_BODY_MAX_CHARS = 300;

const voyageResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS),
      index: z.number().int().nonnegative(),
    })
  ),
  model: z.string(),
  usage: z.object({ total_tokens: z.number().nonnegative() }),
});

// Exported for the unit test: response-shape validation is the part that
// must not drift silently.
export function parseVoyageResponse(
  payload: unknown,
  expectedCount: number
): { model: string; tokens: number; vectors: number[][] } {
  const parsed = voyageResponseSchema.parse(payload);
  if (parsed.data.length !== expectedCount) {
    throw new Error(
      `Voyage returned ${parsed.data.length} embeddings for ${expectedCount} inputs`
    );
  }
  const vectors: number[][] = new Array(parsed.data.length);
  for (const item of parsed.data) {
    vectors[item.index] = item.embedding;
  }
  return { model: parsed.model, tokens: parsed.usage.total_tokens, vectors };
}

export function batchInputs<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

export function createVoyageProvider(apiKey: string): EmbeddingProvider {
  async function embedBatch(
    texts: string[],
    inputType: EmbeddingInputType
  ): Promise<EmbeddingResult> {
    const response = await fetch(VOYAGE_URL, {
      body: JSON.stringify({
        input: texts,
        input_type: inputType,
        model: VOYAGE_MODEL,
        output_dimension: EMBEDDING_DIMENSIONS,
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Voyage embeddings failed (${response.status}): ${body.slice(0, ERROR_BODY_MAX_CHARS)}`
      );
    }
    return parseVoyageResponse(await response.json(), texts.length);
  }

  return {
    async embed(texts, inputType) {
      const result: EmbeddingResult = {
        model: VOYAGE_MODEL,
        tokens: 0,
        vectors: [],
      };
      for (const batch of batchInputs(texts, MAX_BATCH_INPUTS)) {
        // biome-ignore lint/performance/noAwaitInLoops: batches run sequentially to keep order and stay under provider rate limits
        const batchResult = await embedBatch(batch, inputType);
        result.model = batchResult.model;
        result.tokens += batchResult.tokens;
        result.vectors.push(...batchResult.vectors);
      }
      return result;
    },
    name: "voyage",
  };
}
