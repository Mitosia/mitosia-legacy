import type { MastraModelConfig } from "@mastra/core/llm";
import { type AiTask, MODEL_TIERS, routeForTask } from "./config";

// Model-provider seam (decision 2026-08-23, inverting tech-stack §7's
// gateway-first plan): Anthropic DIRECT is the primary — it is the only
// path that guarantees 1h prompt-cache TTL and reaches the Batch API's 50%
// discount, and the Vercel gateway demonstrably downgrades cache TTLs.
// OpenRouter is a break-glass FALLBACK, active only when OPENROUTER_API_KEY
// is set and the primary call fails — never a hop in the healthy path.
// The one deliberate exception (2026-08-26): a per-task tier override that
// names an OpenRouter slug (lib/ai/config.ts) routes that task to
// OpenRouter as the ONLY candidate — the third-party model audition path.
// Adopting a gateway later (multi-provider at S5+) is a change to this one
// file. Keys are raw process.env reads outside serverEnvSchema (the
// TRIGGER_SECRET_KEY precedent): unconfigured degrades to "no analysis",
// never a boot failure.

export interface ModelCandidate {
  // Mastra's model union: it accepts any live AI SDK spec version, which
  // is what lets a v7 Anthropic model and a v5-line OpenRouter model share
  // one seam without adapter shims.
  model: MastraModelConfig;
  // The id actually served — recorded in run rows and ledger metadata, so
  // an audition run is attributed to the real model, never the table tier.
  modelId: string;
  provider: "anthropic" | "openrouter";
}

// Ordered candidates for a task — callers try in order, exactly like the
// transcription provider failover.
export async function getModelCandidates(
  task: AiTask
): Promise<ModelCandidate[]> {
  const route = routeForTask(task);
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  // Audition path: the override named a third-party model, so OpenRouter is
  // the only candidate. Falling back to Anthropic here would silently
  // produce a first-party candidate set labeled as the audition; a missing
  // key is a loud misconfiguration for the same reason. usage.include puts
  // the real billed cost in providerMetadata for the ledger.
  if (route.openrouterModel) {
    if (!openRouterKey) {
      throw new Error(
        `${task} is overridden to OpenRouter model "${route.openrouterModel}" but OPENROUTER_API_KEY is unset`
      );
    }
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    const openrouter = createOpenRouter({ apiKey: openRouterKey });
    return [
      {
        model: openrouter.chat(route.openrouterModel, {
          usage: { include: true },
        }),
        modelId: route.openrouterModel,
        provider: "openrouter",
      },
    ];
  }

  const modelId = MODEL_TIERS[route.tier];
  const candidates: ModelCandidate[] = [];

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: anthropicKey });
    candidates.push({
      model: anthropic(modelId),
      modelId,
      provider: "anthropic",
    });
  }

  if (openRouterKey) {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    const openrouter = createOpenRouter({ apiKey: openRouterKey });
    candidates.push({
      model: openrouter.chat(`anthropic/${modelId}`, {
        usage: { include: true },
      }),
      modelId: `anthropic/${modelId}`,
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
