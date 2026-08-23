import type { LanguageModel } from "ai";
import { type AiTask, MODEL_TIERS, routeForTask } from "./config";

// Model-provider seam (decision 2026-08-23, inverting tech-stack §7's
// gateway-first plan): Anthropic DIRECT is the primary — it is the only
// path that guarantees 1h prompt-cache TTL and reaches the Batch API's 50%
// discount, and the Vercel gateway demonstrably downgrades cache TTLs.
// OpenRouter is a break-glass FALLBACK, active only when OPENROUTER_API_KEY
// is set and the primary call fails — never a hop in the healthy path.
// Adopting a gateway later (multi-provider at S5+) is a change to this one
// file. Keys are raw process.env reads outside serverEnvSchema (the
// TRIGGER_SECRET_KEY precedent): unconfigured degrades to "no analysis",
// never a boot failure.

export interface ModelCandidate {
  model: LanguageModel;
  provider: "anthropic" | "openrouter";
}

// Ordered candidates for a task — callers try in order, exactly like the
// transcription provider failover.
export async function getModelCandidates(
  task: AiTask
): Promise<ModelCandidate[]> {
  const route = routeForTask(task);
  const modelId = MODEL_TIERS[route.tier];
  const candidates: ModelCandidate[] = [];

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: anthropicKey });
    candidates.push({ model: anthropic(modelId), provider: "anthropic" });
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    const openrouter = createOpenRouter({ apiKey: openRouterKey });
    candidates.push({
      model: openrouter.chat(`anthropic/${modelId}`),
      provider: "openrouter",
    });
  }

  return candidates;
}

export function isAiConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY
  );
}
