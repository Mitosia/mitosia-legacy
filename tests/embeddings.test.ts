import { describe, expect, it } from "vitest";
import {
  createMockEmbeddingProvider,
  mockEmbedText,
} from "../lib/ai/embeddings/mock";
import { batchInputs, parseVoyageResponse } from "../lib/ai/embeddings/voyage";
import { EMBEDDING_DIMENSIONS } from "../lib/db/schema/intelligence";

const COUNT_MISMATCH = /1 embeddings for 2 inputs/;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

describe("mock embedding provider", () => {
  it("returns unit vectors of the schema dimension, deterministically", async () => {
    const provider = createMockEmbeddingProvider();
    const first = await provider.embed(["hello semantic world"], "document");
    const second = await provider.embed(["hello semantic world"], "query");
    expect(first.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(first.vectors).toEqual(second.vectors);
    expect(first.tokens).toBe(3);
    const norm = Math.sqrt(
      // biome-ignore lint/style/noNonNullAssertion: asserted length above
      first.vectors[0]!.reduce((sum, v) => sum + v * v, 0)
    );
    expect(norm).toBeCloseTo(1, 6);
  });

  it("ranks word overlap above disjoint text — the e2e retrieval contract", () => {
    const query = mockEmbedText("waveform scrubbing seeks the media");
    const match = mockEmbedText(
      "Speaker 1: clicking the waveform overview seeks the media element"
    );
    const other = mockEmbedText(
      "Speaker 2: quarterly budgets and unrelated planning discussion"
    );
    expect(cosine(query, match)).toBeGreaterThan(cosine(query, other));
  });

  it("ignores punctuation and case", () => {
    expect(mockEmbedText("Hello, World!")).toEqual(
      mockEmbedText("hello world")
    );
  });
});

describe("voyage adapter", () => {
  const vector = (fill: number) => new Array(EMBEDDING_DIMENSIONS).fill(fill);

  it("parses a valid response and restores input order", () => {
    const parsed = parseVoyageResponse(
      {
        data: [
          { embedding: vector(2), index: 1 },
          { embedding: vector(1), index: 0 },
        ],
        model: "voyage-4",
        usage: { total_tokens: 42 },
      },
      2
    );
    expect(parsed.model).toBe("voyage-4");
    expect(parsed.tokens).toBe(42);
    expect(parsed.vectors[0]?.[0]).toBe(1);
    expect(parsed.vectors[1]?.[0]).toBe(2);
  });

  it("rejects wrong dimensions — the provider-contract alarm", () => {
    expect(() =>
      parseVoyageResponse(
        {
          data: [{ embedding: [1, 2, 3], index: 0 }],
          model: "voyage-4",
          usage: { total_tokens: 1 },
        },
        1
      )
    ).toThrow();
  });

  it("rejects a count mismatch", () => {
    expect(() =>
      parseVoyageResponse(
        {
          data: [{ embedding: vector(1), index: 0 }],
          model: "voyage-4",
          usage: { total_tokens: 1 },
        },
        2
      )
    ).toThrow(COUNT_MISMATCH);
  });

  it("splits inputs into provider-sized batches", () => {
    const items = Array.from({ length: 300 }, (_, i) => i);
    const batches = batchInputs(items, 128);
    expect(batches.map((batch) => batch.length)).toEqual([128, 128, 44]);
    expect(batches.flat()).toEqual(items);
  });
});
