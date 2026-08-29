import type { MastraModelConfig } from "@mastra/core/llm";
import type { OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import {
  type AiTask,
  type ModelCapabilities,
  modelDefinitionFor,
  type ReasoningEffort,
  routeForTask,
} from "./config";

// OpenRouter is the single active gateway. Model fallback remains owned by
// Mitosia (the ordered candidate list), while OpenRouter may fail over among
// eligible upstream endpoints for the same explicit model id.

export const OPENROUTER_STRUCTURED_MODEL_SETTINGS = {
  plugins: [{ id: "response-healing" }],
  provider: {
    allow_fallbacks: true,
    data_collection: "deny",
    require_parameters: true,
    zdr: true,
  },
  structuredOutputs: { strict: true },
  usage: { include: true },
} as const satisfies OpenRouterChatSettings;

const UNKNOWN_MODEL_CAPABILITIES: ModelCapabilities = {
  // An explicit environment override may point to a newly auditioned model
  // not yet in the registry. Strict output support is verified at runtime by
  // require_parameters; no model-specific cache/effort hint is assumed.
  promptCaching: "none",
  reasoningEffort: false,
  structuredOutputs: true,
};

export interface ModelCandidate {
  capabilities: ModelCapabilities;
  // Mastra's model union accepts the AI SDK model specification returned by
  // the OpenRouter provider without an adapter shim.
  model: MastraModelConfig;
  modelId: string;
  provider: "openrouter";
  reasoningEffort?: ReasoningEffort;
}

function settingsForCandidate(
  capabilities: ModelCapabilities,
  reasoningEffort: ReasoningEffort | undefined
): OpenRouterChatSettings {
  return {
    ...OPENROUTER_STRUCTURED_MODEL_SETTINGS,
    ...(reasoningEffort && capabilities.reasoningEffort
      ? { reasoning: { effort: reasoningEffort } }
      : {}),
  };
}

export async function getModelCandidates(
  task: AiTask
): Promise<ModelCandidate[]> {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    return [];
  }

  const route = routeForTask(task);
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
  const openrouter = createOpenRouter({
    apiKey: openRouterKey,
    appName: "Mitosia",
    compatibility: "strict",
  });

  return route.modelIds.map((modelId) => {
    const definition = modelDefinitionFor(modelId);
    const capabilities = definition
      ? definition.capabilities
      : UNKNOWN_MODEL_CAPABILITIES;
    const reasoningEffort = capabilities.reasoningEffort
      ? route.reasoningEffort
      : undefined;
    return {
      capabilities,
      model: openrouter.chat(
        modelId,
        settingsForCandidate(capabilities, reasoningEffort)
      ),
      modelId,
      provider: "openrouter" as const,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  });
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}
