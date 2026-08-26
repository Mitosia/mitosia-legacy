import { NoObjectGeneratedError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Regression guards for the transient-failure handling added after staging
// 2026-08-25: the extraction qa pass returned JSON that missed the schema
// once, the whole task run was marked failed between Trigger attempts, and
// the UI showed a terminal error for a run that succeeded seconds later.
// generateStructured now absorbs one-off schema misses with a single
// same-candidate retry — while budget exhaustion stays loud (a route-sizing
// bug must never be silently retried into a different-looking failure).

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: vi.fn() };
});
vi.mock("../lib/ai/provider", () => ({
  getModelCandidates: vi.fn(async () => [
    {
      model: { id: "mock-model" },
      modelId: "mock-model",
      provider: "anthropic",
    },
  ]),
}));

import { generateObject } from "ai";
import { generateStructured } from "../lib/ai/generate";

const mockGenerate = vi.mocked(generateObject);

const schema = z.object({ answer: z.string() });
const BUDGET_ERROR = /exhausted its output budget/;

function schemaMiss(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    finishReason: "stop",
    message: "response did not match schema",
    response: { id: "resp-1", modelId: "mock-model", timestamp: new Date(0) },
    text: "{}",
    usage: {
      inputTokenDetails: {
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        noCacheTokens: undefined,
      },
      inputTokens: 0,
      outputTokenDetails: {
        reasoningTokens: undefined,
        textTokens: undefined,
      },
      outputTokens: 0,
      totalTokens: 0,
    },
  });
}

function budgetMiss(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    finishReason: "length",
    message: "the model did not return a response",
    response: { id: "resp-2", modelId: "mock-model", timestamp: new Date(0) },
    text: "",
    usage: {
      inputTokenDetails: {
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        noCacheTokens: undefined,
      },
      inputTokens: 0,
      outputTokenDetails: {
        reasoningTokens: undefined,
        textTokens: undefined,
      },
      outputTokens: 0,
      totalTokens: 0,
    },
  });
}

// Only the fields generateStructured reads.
const success = {
  object: { answer: "ok" },
  usage: { inputTokens: 10, outputTokens: 5 },
} as Awaited<ReturnType<typeof generateObject>>;

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("generateStructured schema-miss retry", () => {
  it("retries the same candidate once on a schema mismatch", async () => {
    mockGenerate.mockRejectedValueOnce(schemaMiss());
    mockGenerate.mockResolvedValueOnce(success);

    const result = await generateStructured(
      "evals.judge",
      "system",
      "prompt",
      schema
    );
    expect(result.output).toEqual({ answer: "ok" });
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded retry and rethrows", async () => {
    mockGenerate.mockRejectedValue(schemaMiss());

    await expect(
      generateStructured("evals.judge", "system", "prompt", schema)
    ).rejects.toThrow(NoObjectGeneratedError);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("never retries budget exhaustion — that is a sizing bug, kept loud", async () => {
    mockGenerate.mockRejectedValue(budgetMiss());

    await expect(
      generateStructured("evals.judge", "system", "prompt", schema)
    ).rejects.toThrow(BUDGET_ERROR);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("never retries non-schema errors on the same candidate", async () => {
    mockGenerate.mockRejectedValue(new Error("529 overloaded"));

    await expect(
      generateStructured("evals.judge", "system", "prompt", schema)
    ).rejects.toThrow("529 overloaded");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});
