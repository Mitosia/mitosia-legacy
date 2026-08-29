import type { OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_PROFILES } from "../lib/ai/config";
import {
  getModelCandidates,
  isAiConfigured,
  OPENROUTER_STRUCTURED_MODEL_SETTINGS,
} from "../lib/ai/provider";

interface InspectableOpenRouterModel {
  config: {
    compatibility: string;
    headers: () => Record<string, string>;
  };
  settings: OpenRouterChatSettings;
}

function inspectModel(model: unknown): InspectableOpenRouterModel {
  return model as InspectableOpenRouterModel;
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.MOMENT_DISCOVERY_MODELS;
  delete process.env.MOMENT_DISCOVERY_TIER;
});

describe("getModelCandidates", () => {
  it("returns the editorial model profile in Mitosia-owned fallback order", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
    const candidates = await getModelCandidates("moment-discovery.candidates");
    expect(candidates.map((candidate) => candidate.modelId)).toEqual(
      MODEL_PROFILES.editorial
    );
    expect(candidates.map((candidate) => candidate.provider)).toEqual([
      "openrouter",
      "openrouter",
      "openrouter",
      "openrouter",
    ]);
  });

  it("uses an explicit single-model override without an implicit fallback", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
    process.env.MOMENT_DISCOVERY_MODELS = "moonshotai/kimi-k3";
    const candidates = await getModelCandidates("moment-discovery.candidates");
    expect(candidates.map((candidate) => candidate.modelId)).toEqual([
      "moonshotai/kimi-k3",
    ]);
  });

  it("applies strict structured-output, routing, privacy, and healing controls", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
    const [candidate] = await getModelCandidates("source-analysis.editorial");
    const model = inspectModel(candidate.model);

    expect(OPENROUTER_STRUCTURED_MODEL_SETTINGS).toMatchObject({
      plugins: [{ id: "response-healing" }],
      provider: {
        allow_fallbacks: true,
        data_collection: "deny",
        require_parameters: true,
        zdr: true,
      },
      structuredOutputs: { strict: true },
      usage: { include: true },
    });
    expect(model.settings).toMatchObject(OPENROUTER_STRUCTURED_MODEL_SETTINGS);
  });

  it("uses strict SDK compatibility and identifies the application", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
    const [candidate] = await getModelCandidates("source-analysis.chapters");
    const model = inspectModel(candidate.model);
    expect(model.config.compatibility).toBe("strict");
    expect(model.config.headers()).toMatchObject({
      "X-OpenRouter-Title": "Mitosia",
    });
  });

  it("translates provider-neutral effort only for models that support it", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
    const candidates = await getModelCandidates("clip-fine.cut");
    const sonnet = candidates.find(({ modelId }) =>
      modelId.includes("claude-sonnet")
    );
    const kimi = candidates.find(({ modelId }) => modelId.includes("kimi-k3"));

    expect(sonnet?.reasoningEffort).toBe("medium");
    expect(inspectModel(sonnet?.model).settings.reasoning).toEqual({
      effort: "medium",
    });
    expect(kimi?.reasoningEffort).toBeUndefined();
    expect(inspectModel(kimi?.model).settings.reasoning).toBeUndefined();
  });

  it("ignores an Anthropic key because OpenRouter is the only transport", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(await getModelCandidates("evals.judge")).toEqual([]);
    expect(isAiConfigured()).toBe(false);
  });

  it("is configured by an OpenRouter key alone", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
    expect(isAiConfigured()).toBe(true);
    expect(await getModelCandidates("source-analysis.chapters")).toHaveLength(
      4
    );
  });
});
