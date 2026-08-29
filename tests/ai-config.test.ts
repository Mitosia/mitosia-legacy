import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL_PROFILES,
  modelDefinitionFor,
  modelFamilyFor,
  OPENROUTER_MODELS,
  routeForTask,
  TASK_ROUTES,
} from "../lib/ai/config";

const OVERRIDE_ENV_VARS = [
  "MOMENT_DISCOVERY_MODELS",
  "MOMENT_DISCOVERY_TIER",
  "SEGMENT_PLAN_MODELS",
  "SEGMENT_PLAN_TIER",
  "SEGMENT_PUBLISHER_EDITOR_MODELS",
  "SEGMENT_PUBLISHER_EDITOR_TIER",
  "SEGMENT_PUBLISHER_VERIFIER_MODELS",
  "SEGMENT_PUBLISHER_VERIFIER_TIER",
] as const;

afterEach(() => {
  for (const envVar of OVERRIDE_ENV_VARS) {
    delete process.env[envVar];
  }
});

describe("provider-neutral model profiles", () => {
  it("gives every route a positive budget and a structured-output requirement", () => {
    for (const route of Object.values(TASK_ROUTES)) {
      expect(route.maxOutputTokens).toBeGreaterThan(0);
      expect(route.requiredCapabilities).toContain("structuredOutputs");
      expect(MODEL_PROFILES[route.profile].length).toBeGreaterThan(0);
    }
  });

  it("orders all four requested frontier families in the editorial profile", () => {
    expect(MODEL_PROFILES.editorial).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-5.6-sol",
      "google/gemini-3.1-pro-preview",
      "moonshotai/kimi-k3",
    ]);
    expect(
      MODEL_PROFILES.editorial.map(
        (modelId) => modelDefinitionFor(modelId)?.family
      )
    ).toEqual(["anthropic", "openai", "google", "moonshot"]);
  });

  it("starts the independent critic in a different family from the editor", () => {
    expect(MODEL_PROFILES.critic).toEqual([
      "openai/gpt-5.6-sol",
      "google/gemini-3.1-pro-preview",
      "anthropic/claude-opus-5",
      "moonshotai/kimi-k3",
    ]);
    expect(routeForTask("segment-publisher.edit").profile).toBe("editorial");
    expect(routeForTask("segment-publisher.verify").profile).toBe("critic");
  });

  it("resolves registered and override slugs to a verifier family", () => {
    expect(modelFamilyFor("anthropic/claude-opus-5")).toBe("anthropic");
    expect(modelFamilyFor("anthropic/claude-future-9")).toBe("anthropic");
    expect(modelFamilyFor("moonshotai/kimi-future")).toBe("moonshot");
    expect(modelFamilyFor("vendor/custom-model-v1")).toBe(
      "openrouter-vendor:vendor"
    );
  });

  it("contains only explicit model ids, never a moving router alias", () => {
    for (const model of Object.values(OPENROUTER_MODELS)) {
      expect(model.id).toContain("/");
      expect(model.id).not.toContain("latest");
      expect(model.id).not.toBe("openrouter/auto");
      expect(model.id.startsWith("~")).toBe(false);
      expect(model.capabilities.structuredOutputs).toBe(true);
    }
  });

  it("resolves routes to ordered model ids instead of provider tiers", () => {
    const editorial = routeForTask("moment-discovery.candidates");
    expect(editorial.profile).toBe("editorial");
    expect(editorial.modelIds).toEqual(MODEL_PROFILES.editorial);

    const efficient = routeForTask("source-analysis.chapters");
    expect(efficient.profile).toBe("efficient");
    expect(efficient.modelIds).toEqual([
      OPENROUTER_MODELS.claudeHaiku.id,
      OPENROUTER_MODELS.geminiPro.id,
      OPENROUTER_MODELS.gptSol.id,
      OPENROUTER_MODELS.kimiK3.id,
    ]);
  });
});

describe("model overrides", () => {
  it("lets editor and verifier use independent explicit candidate pools", () => {
    process.env.SEGMENT_PUBLISHER_EDITOR_MODELS =
      "anthropic/claude-opus-5,google/gemini-3.1-pro-preview";
    process.env.SEGMENT_PUBLISHER_VERIFIER_MODELS =
      "openai/gpt-5.6-sol,moonshotai/kimi-k3";

    expect(routeForTask("segment-publisher.edit").modelIds).toEqual([
      "anthropic/claude-opus-5",
      "google/gemini-3.1-pro-preview",
    ]);
    expect(routeForTask("segment-publisher.verify").modelIds).toEqual([
      "openai/gpt-5.6-sol",
      "moonshotai/kimi-k3",
    ]);
  });

  it("accepts one explicit model through the preferred models variable", () => {
    process.env.MOMENT_DISCOVERY_MODELS = "moonshotai/kimi-k3";
    expect(routeForTask("moment-discovery.candidates").modelIds).toEqual([
      "moonshotai/kimi-k3",
    ]);
  });

  it("accepts and deduplicates an ordered comma-separated candidate list", () => {
    process.env.MOMENT_DISCOVERY_MODELS =
      "openai/gpt-5.6-sol, google/gemini-3.1-pro-preview, openai/gpt-5.6-sol";
    expect(routeForTask("moment-discovery.candidates").modelIds).toEqual([
      "openai/gpt-5.6-sol",
      "google/gemini-3.1-pro-preview",
    ]);
  });

  it("keeps the legacy tier variable as a single-model compatibility path", () => {
    process.env.SEGMENT_PLAN_TIER = "haiku";
    expect(routeForTask("segment-plan.partition").modelIds).toEqual([
      "anthropic/claude-haiku-4.5",
    ]);

    process.env.SEGMENT_PLAN_TIER = "opus";
    expect(routeForTask("segment-plan.reconcile").modelIds).toEqual([
      "anthropic/claude-opus-5",
    ]);
  });

  it("also accepts explicit candidates in the legacy variable", () => {
    process.env.MOMENT_DISCOVERY_TIER =
      "google/gemini-3.1-pro-preview,moonshotai/kimi-k3";
    expect(routeForTask("moment-discovery.candidates").modelIds).toEqual([
      "google/gemini-3.1-pro-preview",
      "moonshotai/kimi-k3",
    ]);
  });

  it("prefers the provider-neutral models variable over the legacy tier", () => {
    process.env.MOMENT_DISCOVERY_MODELS = "openai/gpt-5.6-sol";
    process.env.MOMENT_DISCOVERY_TIER = "opus";
    expect(routeForTask("moment-discovery.candidates").modelIds).toEqual([
      "openai/gpt-5.6-sol",
    ]);
  });

  it("ignores malformed and moving-alias overrides", () => {
    for (const invalid of [
      "gpt-5",
      "not a model/id with spaces",
      "openrouter/auto",
      "~anthropic/claude-opus-latest",
      "anthropic/claude-opus-latest",
    ]) {
      process.env.MOMENT_DISCOVERY_MODELS = invalid;
      expect(routeForTask("moment-discovery.candidates").modelIds).toEqual(
        MODEL_PROFILES.editorial
      );
    }
  });
});
