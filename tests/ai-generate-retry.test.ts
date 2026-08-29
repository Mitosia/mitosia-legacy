import { APICallError, NoObjectGeneratedError } from "ai";
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

const { mockGetModelCandidates } = vi.hoisted(() => ({
  mockGetModelCandidates: vi.fn(),
}));

vi.mock("../lib/ai/provider", () => ({
  getModelCandidates: mockGetModelCandidates,
}));

import { generateObject } from "ai";
import {
  captureStructuredUsage,
  generateStructured,
  StructuredGenerationError,
  type StructuredUsage,
} from "../lib/ai/generate";

const mockGenerate = vi.mocked(generateObject);

const schema = z.object({ answer: z.string() });
const BUDGET_ERROR = /exhausted its output budget/;
const GENERATION_FAILED = /AI generation failed/;
const SESSION_ID = /^mitosia_[a-f0-9]{32}$/;

function schemaMiss(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    cause: Object.assign(new Error("schema validation failed"), {
      issues: [
        {
          code: "invalid_type",
          message: "expected string",
          path: ["answer"],
        },
      ],
    }),
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

function contentFilterMiss(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    finishReason: "content-filter",
    message: "response was filtered",
    response: { id: "resp-3", modelId: "mock-model", timestamp: new Date(0) },
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

function refusalMiss(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    finishReason: "stop",
    message: "the model did not return an object",
    response: {
      body: {
        choices: [{ message: { refusal: "I cannot help with that request." } }],
      },
      id: "resp-4",
      modelId: "mock-model",
      timestamp: new Date(0),
    },
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

function gatewayError(statusCode: number): APICallError {
  return new APICallError({
    isRetryable: false,
    message: `gateway rejected ${statusCode}`,
    requestBodyValues: { privateTranscript: "must never escape" },
    responseBody: '{"error":"account failure"}',
    statusCode,
    url: "https://openrouter.ai/api/v1/chat/completions",
  });
}

function candidate(
  modelId: string,
  promptCaching: "automatic" | "explicit" | "none" = "explicit"
) {
  return {
    capabilities: {
      promptCaching,
      reasoningEffort: true,
      structuredOutputs: true,
    },
    model: { id: modelId },
    modelId,
    provider: "openrouter" as const,
  };
}

function sessionIdAt(callIndex: number): unknown {
  const openrouter = mockGenerate.mock.calls[callIndex]?.[0].providerOptions
    ?.openrouter as { session_id?: unknown } | undefined;
  return openrouter?.session_id;
}

// Only the fields generateStructured reads.
const success = {
  object: { answer: "ok" },
  usage: { inputTokens: 10, outputTokens: 5 },
} as Awaited<ReturnType<typeof generateObject>>;

beforeEach(() => {
  mockGenerate.mockReset();
  mockGetModelCandidates.mockReset();
  mockGetModelCandidates.mockResolvedValue([candidate("mock-model")]);
});

describe("generateStructured schema-miss retry", () => {
  it("forwards hardened OpenRouter routing and response-healing controls", async () => {
    mockGenerate.mockResolvedValueOnce(success);

    await generateStructured("evals.judge", "system", "prompt", schema, {
      outputStrategy: "strictJsonSchema",
    });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        maxRetries: 0,
        providerOptions: {
          openrouter: expect.objectContaining({
            plugins: [{ id: "response-healing" }],
            provider: {
              allow_fallbacks: true,
              data_collection: "deny",
              require_parameters: true,
              zdr: true,
            },
          }),
        },
        schemaName: "evals_judge",
      })
    );
  });

  it("uses an OpenRouter cache breakpoint and a hashed sticky session", async () => {
    mockGenerate.mockResolvedValue(success);

    await generateStructured("evals.judge", "system", "job", schema, {
      cachedPrefix: "private transcript prefix",
    });
    await generateStructured("evals.judge", "system", "another job", schema, {
      cachedPrefix: "private transcript prefix",
    });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            content: [
              expect.objectContaining({
                providerOptions: {
                  openrouter: {
                    cacheControl: { ttl: "5m", type: "ephemeral" },
                  },
                },
                text: "private transcript prefix",
              }),
              { text: "job", type: "text" },
            ],
            role: "user",
          },
        ],
        providerOptions: {
          openrouter: expect.objectContaining({
            session_id: expect.stringMatching(SESSION_ID),
          }),
        },
      })
    );

    const request = mockGenerate.mock.calls[0]?.[0];
    expect(JSON.stringify(request?.providerOptions)).not.toContain(
      "private transcript prefix"
    );
    const firstSession = sessionIdAt(0);
    const secondSession = sessionIdAt(1);
    expect(secondSession).toBe(firstSession);
  });

  it("uses implicit caching without an unsupported explicit breakpoint", async () => {
    mockGetModelCandidates.mockResolvedValue([
      candidate("google/gemini-pro", "automatic"),
    ]);
    mockGenerate.mockResolvedValueOnce(success);

    await generateStructured("evals.judge", "system", "job", schema, {
      cachedPrefix: "shared prefix",
      cacheSessionKey: "source-123:editorial",
    });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            content: [
              { text: "shared prefix", type: "text" },
              { text: "job", type: "text" },
            ],
            role: "user",
          },
        ],
      })
    );
  });

  it("records billed OpenRouter cost and the actual upstream endpoint", async () => {
    mockGenerate.mockResolvedValueOnce({
      ...success,
      providerMetadata: {
        openrouter: {
          provider: " Google AI Studio ",
          usage: { cost: 0.0123 },
        },
      },
    });

    const result = await generateStructured(
      "evals.judge",
      "system",
      "prompt",
      schema
    );

    expect(result.usage).toMatchObject({
      attemptedModels: ["mock-model"],
      attempts: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.0123,
      provider: "openrouter",
      upstreamProvider: "Google AI Studio",
    });
  });

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
    expect(mockGenerate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining("Rejected response (bounded JSON):"),
      })
    );
    expect(mockGenerate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prompt: expect.stringContaining("{}") })
    );
    expect(mockGenerate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining('"path":["answer"]'),
      })
    );
  });

  it("retries exact validation layered after a permissive transport", async () => {
    mockGenerate
      .mockResolvedValueOnce({
        ...success,
        object: { answer: "wrong mode" },
      })
      .mockResolvedValueOnce(success);

    const result = await generateStructured(
      "evals.judge",
      "system",
      "prompt",
      schema,
      {
        validateOutput: (output) => {
          if (output.answer !== "ok") {
            throw new Error("answer must be ok");
          }
          return output;
        },
      }
    );

    expect(result.output).toEqual({ answer: "ok" });
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockGenerate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining("answer must be ok"),
      })
    );
    expect(mockGenerate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining('{"answer":"wrong mode"}'),
      })
    );
  });

  it("accounts for every billed semantic-repair attempt", async () => {
    mockGenerate
      .mockResolvedValueOnce({
        object: { answer: "repair me" },
        providerMetadata: {
          openrouter: { provider: "Anthropic", usage: { cost: 0.01 } },
        },
        usage: {
          inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 7 },
          inputTokens: 10,
          outputTokens: 4,
        },
      } as unknown as Awaited<ReturnType<typeof generateObject>>)
      .mockResolvedValueOnce({
        object: { answer: "ok" },
        providerMetadata: {
          openrouter: { provider: "Anthropic", usage: { cost: 0.02 } },
        },
        usage: {
          inputTokenDetails: { cacheReadTokens: 8, cacheWriteTokens: 0 },
          inputTokens: 12,
          outputTokens: 5,
        },
      } as unknown as Awaited<ReturnType<typeof generateObject>>);

    const result = await generateStructured(
      "evals.judge",
      "system",
      "prompt",
      schema,
      {
        validateOutput: (output) => {
          if (output.answer !== "ok") {
            throw new Error("answer must be ok");
          }
          return output;
        },
      }
    );

    expect(result.usage).toMatchObject({
      attemptedModels: ["mock-model"],
      attempts: 2,
      cacheReadTokens: 11,
      cacheWriteTokens: 7,
      costUsd: 0.03,
      inputTokens: 22,
      model: "mock-model",
      outputTokens: 9,
      upstreamProvider: "Anthropic",
    });
  });

  it("gives up after the bounded retry and rethrows", async () => {
    mockGenerate.mockRejectedValue(schemaMiss());

    await expect(
      generateStructured("evals.judge", "system", "prompt", schema)
    ).rejects.toThrow(GENERATION_FAILED);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("captures completed siblings and terminal usage before propagating failure", async () => {
    const captured: StructuredUsage[] = [];
    mockGenerate.mockResolvedValueOnce(success).mockRejectedValue(schemaMiss());

    await expect(
      captureStructuredUsage(captured, async () => {
        await generateStructured("evals.judge", "system", "first", schema);
        await generateStructured("evals.judge", "system", "second", schema);
      })
    ).rejects.toBeInstanceOf(StructuredGenerationError);

    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({ attempts: 1, model: "mock-model" });
    expect(captured[1]).toMatchObject({ attempts: 2, model: "mock-model" });
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
    ).rejects.toThrow("AI generation failed");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("does not retry a refusal on the same candidate", async () => {
    mockGenerate.mockRejectedValue(contentFilterMiss());

    await expect(
      generateStructured("evals.judge", "system", "prompt", schema)
    ).rejects.toThrow("blocked by provider safety policy");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("does not bypass a raw OpenAI refusal through another model", async () => {
    mockGetModelCandidates.mockResolvedValue([
      candidate("openai/gpt-sol", "automatic"),
      candidate("anthropic/claude-opus"),
    ]);
    mockGenerate.mockRejectedValue(refusalMiss());

    await expect(
      generateStructured("evals.judge", "system", "prompt", schema)
    ).rejects.toThrow("blocked by provider safety policy");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("does not hide output-budget exhaustion behind model fallback", async () => {
    mockGetModelCandidates.mockResolvedValue([
      candidate("anthropic/claude-opus"),
      candidate("openai/gpt-sol", "automatic"),
    ]);
    mockGenerate.mockRejectedValue(budgetMiss());

    await expect(
      generateStructured("evals.judge", "system", "prompt", schema)
    ).rejects.toThrow(BUDGET_ERROR);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it.each([401, 402, 403])(
    "fails fast on gateway-wide status %s",
    async (statusCode) => {
      mockGetModelCandidates.mockResolvedValue([
        candidate("anthropic/claude-opus"),
        candidate("openai/gpt-sol", "automatic"),
      ]);
      mockGenerate.mockRejectedValue(gatewayError(statusCode));

      await expect(
        generateStructured("evals.judge", "system", "prompt", schema)
      ).rejects.toThrow(`statusCode=${statusCode}`);
      expect(mockGenerate).toHaveBeenCalledTimes(1);
    }
  );

  it("fails over to the next model after a non-schema provider error", async () => {
    mockGetModelCandidates.mockResolvedValue([
      candidate("anthropic/claude-opus"),
      candidate("openai/gpt-sol", "automatic"),
    ]);
    mockGenerate
      .mockRejectedValueOnce(new Error("endpoint unavailable"))
      .mockResolvedValueOnce(success);

    const result = await generateStructured(
      "evals.judge",
      "system",
      "prompt",
      schema
    );

    expect(result.output).toEqual({ answer: "ok" });
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockGenerate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ model: { id: "anthropic/claude-opus" } })
    );
    expect(mockGenerate.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ model: { id: "openai/gpt-sol" } })
    );
  });
});
