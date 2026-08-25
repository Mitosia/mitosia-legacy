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

// Rate-limit bursts (429) and provider 5xx retry in place before the run
// fails: a whole-source index is hundreds of chunks, and one throttled
// batch should cost seconds, not a failed source_index a human has to
// notice. Bounded, so a *persistent* 429 (e.g. no payment method on the
// account) still fails loudly with the provider's own message after
// ~7s of backoff.
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableVoyageStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Exported for the unit test. Exponential doubling from the base, floored
// by the server's own Retry-After when it names a bigger delay (seconds
// form only — the HTTP-date form parses as NaN and falls through), capped.
export function voyageRetryDelayMs(
  attempt: number,
  retryAfterHeader: string | null
): number {
  const backoff = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const retryAfterSeconds = Number(retryAfterHeader);
  const fromHeader =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 0;
  return Math.min(Math.max(backoff, fromHeader), RETRY_MAX_DELAY_MS);
}

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
    for (let attempt = 0; ; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: retries are sequential by definition
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
      if (response.ok) {
        return parseVoyageResponse(await response.json(), texts.length);
      }
      if (attempt < MAX_RETRIES && isRetryableVoyageStatus(response.status)) {
        await sleep(
          voyageRetryDelayMs(attempt, response.headers.get("retry-after"))
        );
        continue;
      }
      const body = await response.text().catch(() => "");
      throw new Error(
        `Voyage embeddings failed (${response.status}): ${body.slice(0, ERROR_BODY_MAX_CHARS)}`
      );
    }
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
