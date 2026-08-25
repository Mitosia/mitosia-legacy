import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMockEmbeddingProvider,
  mockEmbedText,
} from "../lib/ai/embeddings/mock";
import {
  batchInputs,
  createVoyageProvider,
  isRetryableVoyageStatus,
  parseVoyageResponse,
  voyageRetryDelayMs,
} from "../lib/ai/embeddings/voyage";
import { EMBEDDING_DIMENSIONS } from "../lib/db/schema/intelligence";

const COUNT_MISMATCH = /1 embeddings for 2 inputs/;
const EXHAUSTED_429 = /Voyage embeddings failed \(429\): rate limited/;
const UNAUTHORIZED_401 = /Voyage embeddings failed \(401\)/;

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

describe("voyage retry policy", () => {
  const vector = () => new Array(EMBEDDING_DIMENSIONS).fill(0.5);
  const okBody = () => ({
    data: [{ embedding: vector(), index: 0 }],
    model: "voyage-4",
    usage: { total_tokens: 2 },
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries rate limits and server errors, not client errors", () => {
    expect(isRetryableVoyageStatus(429)).toBe(true);
    expect(isRetryableVoyageStatus(500)).toBe(true);
    expect(isRetryableVoyageStatus(503)).toBe(true);
    expect(isRetryableVoyageStatus(400)).toBe(false);
    expect(isRetryableVoyageStatus(401)).toBe(false);
  });

  it("backs off exponentially, floored by Retry-After and capped", () => {
    expect(voyageRetryDelayMs(0, null)).toBe(1000);
    expect(voyageRetryDelayMs(1, null)).toBe(2000);
    expect(voyageRetryDelayMs(2, null)).toBe(4000);
    // The server's own delay wins when it is longer than the backoff…
    expect(voyageRetryDelayMs(0, "5")).toBe(5000);
    // …and never shortens it.
    expect(voyageRetryDelayMs(3, "2")).toBe(8000);
    // HTTP-date form is legal Retry-After; it parses as NaN and falls through.
    expect(voyageRetryDelayMs(0, "Wed, 21 Oct 2026 07:28:00 GMT")).toBe(1000);
    expect(voyageRetryDelayMs(10, null)).toBe(30_000);
  });

  it("recovers when a 429 is followed by success", async () => {
    vi.useFakeTimers();
    const responses = [
      new Response("slow down", {
        headers: { "retry-after": "1" },
        status: 429,
      }),
      Response.json(okBody()),
    ];
    const fetchMock = vi.fn(() => Promise.resolve(responses.shift()));
    vi.stubGlobal("fetch", fetchMock);

    const pending = createVoyageProvider("test-key").embed(["hi"], "document");
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.tokens).toBe(2);
    expect(result.vectors).toHaveLength(1);
  });

  it("gives up after the retry budget with the provider's message", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response("rate limited", { status: 429 }))
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = createVoyageProvider("test-key").embed(["hi"], "document");
    const assertion = expect(pending).rejects.toThrow(EXHAUSTED_429);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry a non-retryable status", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response("bad key", { status: 401 }))
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createVoyageProvider("test-key").embed(["hi"], "document")
    ).rejects.toThrow(UNAUTHORIZED_401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
