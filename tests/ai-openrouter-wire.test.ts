import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured } from "../lib/ai/generate";

const SESSION_ID = /^mitosia_[a-f0-9]{32}$/;

interface CapturedRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  url: string;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenRouter structured-output wire contract", () => {
  it("serializes hardened controls through the real adapter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
    vi.stubEnv("CLIP_FINE_MODELS", "anthropic/claude-sonnet-5");

    let captured: CapturedRequest | undefined;
    const fakeFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: Object.fromEntries(new Headers(init?.headers)),
        url: String(input),
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                index: 0,
                message: {
                  content: JSON.stringify({ answer: "ok" }),
                  role: "assistant",
                },
              },
            ],
            id: "gen-wire-contract",
            model: "anthropic/claude-sonnet-5",
            provider: "Anthropic",
            usage: {
              completion_tokens: 5,
              cost: 0.0123,
              prompt_tokens: 10,
              total_tokens: 15,
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          }
        )
      );
    });
    vi.stubGlobal("fetch", fakeFetch);

    const result = await generateStructured(
      "clip-fine.cut",
      "You are a precise editor.",
      "Return the answer.",
      z.object({ answer: z.string() }),
      {
        cachedPrefix: "Shared transcript prefix",
        cacheSessionKey: "org-1:source-2:clip-fine",
        outputStrategy: "strictJsonSchema",
      }
    );

    expect(fakeFetch).toHaveBeenCalledOnce();
    expect(captured).toBeDefined();
    expect(captured?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured?.headers).toMatchObject({
      authorization: "Bearer test-openrouter",
      "x-openrouter-title": "Mitosia",
    });

    expect(captured?.body).toMatchObject({
      max_tokens: 3000,
      messages: [
        {
          content: [
            {
              text: "You are a precise editor.",
              type: "text",
            },
          ],
          role: "system",
        },
        {
          content: [
            {
              cache_control: { ttl: "5m", type: "ephemeral" },
              text: "Shared transcript prefix",
              type: "text",
            },
            { text: "Return the answer.", type: "text" },
          ],
          role: "user",
        },
      ],
      model: "anthropic/claude-sonnet-5",
      plugins: [{ id: "response-healing" }],
      provider: {
        allow_fallbacks: true,
        data_collection: "deny",
        require_parameters: true,
        zdr: true,
      },
      reasoning: { effort: "medium" },
      response_format: {
        json_schema: {
          name: "clip-fine_cut",
          schema: {
            additionalProperties: false,
            properties: { answer: { type: "string" } },
            required: ["answer"],
            type: "object",
          },
          strict: true,
        },
        type: "json_schema",
      },
      session_id: expect.stringMatching(SESSION_ID),
      usage: { include: true },
    });
    expect(captured?.body).not.toHaveProperty("extraBody");

    expect(result.output).toEqual({ answer: "ok" });
    expect(result.usage).toMatchObject({
      costUsd: 0.0123,
      inputTokens: 10,
      model: "anthropic/claude-sonnet-5",
      outputTokens: 5,
      provider: "openrouter",
      upstreamProvider: "Anthropic",
    });
  });
});
