import { afterEach, describe, expect, it, vi } from "vitest";
import { routeForTask } from "../lib/ai/config";
import { getModelCandidates, isAiConfigured } from "../lib/ai/provider";

// The seam's contract: routing comes from the table, provider order is
// Anthropic-direct first, OpenRouter strictly as fallback, and an
// unconfigured environment yields an empty list — never a throw.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("routeForTask", () => {
  it("routes cheap passes to haiku and editorial work to sonnet", () => {
    expect(routeForTask("source-analysis.chapters").tier).toBe("haiku");
    expect(routeForTask("source-analysis.editorial").tier).toBe("sonnet");
    expect(routeForTask("evals.judge").tier).toBe("sonnet");
  });
});

describe("getModelCandidates", () => {
  it("orders anthropic before openrouter when both are configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
    const candidates = await getModelCandidates("source-analysis.editorial");
    expect(candidates.map((candidate) => candidate.provider)).toEqual([
      "anthropic",
      "openrouter",
    ]);
  });

  it("falls back to openrouter alone when it is the only key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
    const candidates = await getModelCandidates("source-analysis.chapters");
    expect(candidates.map((candidate) => candidate.provider)).toEqual([
      "openrouter",
    ]);
  });

  it("returns no candidates when nothing is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(await getModelCandidates("evals.judge")).toEqual([]);
    expect(isAiConfigured()).toBe(false);
  });
});
