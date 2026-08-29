import { generateObject, NoObjectGeneratedError } from "ai";
import type { z } from "zod";
import {
  type AiTask,
  EFFORT_TIERS,
  estimateCostUsd,
  routeForTask,
} from "./config";
import { getModelCandidates } from "./provider";

// Structured generation through the seam: AI SDK generateObject — one model
// call producing a structured object — with ordered provider failover and
// usage accounting. Native output format is the default; callers whose
// shared schema exceeds Anthropic's grammar budget can select its JSON
// response tool. Deliberately not Mastra's agent.generate({structuredOutput}):
// that path runs a second-pass "structuring agent" that re-extracts the
// first pass's free text into the schema, and on staging (2026-08-23,
// Karma source) it silently filled unmappable fields with literal
// "placeholder" strings that passed schema validation. Both supported modes
// are one model call: cheaper, deterministic, and locally validated.
//
// Telemetry: per-call experimental_telemetry lights up the OTel spans the
// LangfuseSpanProcessor (lib/ai/telemetry.ts) is registered for.

// One-shot diagnostic: whether AI SDK telemetry integrations are actually
// registered when the first generation runs, and which OTel provider is
// global. Cheap, and it turns "why are there no spans" from a deploy-cycle
// mystery into one line in the run log.
let telemetryStateLogged = false;
function logTelemetryStateOnce(): void {
  if (telemetryStateLogged) {
    return;
  }
  telemetryStateLogged = true;
  const integrations =
    (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] })
      .AI_SDK_TELEMETRY_INTEGRATIONS ?? [];
  import("@opentelemetry/api")
    .then(({ trace }) => {
      console.info(
        `[ai] telemetry state: integrations=${integrations.length} provider=${trace.getTracerProvider().constructor.name}`
      );
    })
    .catch(() => {
      console.info(
        `[ai] telemetry state: integrations=${integrations.length} provider=unknown`
      );
    });
}

export interface StructuredUsage {
  costUsd: number | null;
  inputTokens: number;
  model: string;
  outputTokens: number;
  provider: string;
  task: AiTask;
}

export interface StructuredResult<T> {
  output: T;
  usage: StructuredUsage;
}

export interface GenerateStructuredOptions<T = unknown> {
  // Anthropic's native output-format compiler has a finite grammar budget.
  // Large, shared episode schemas may deliberately use the JSON response
  // tool instead; callers still validate the returned object locally.
  anthropicStructuredOutputMode?: "auto" | "jsonTool" | "outputFormat";
  // A shared prefix (context + transcript) cached across sibling calls via
  // an Anthropic cache breakpoint. Callers making several passes over the
  // same long document put the document here and only the per-pass
  // instructions in `prompt` — and must keep `system`, the schema, and this
  // prefix IDENTICAL across the group, because tools/output-format and
  // system precede messages in the cache key. Caches are per-model: prime
  // with one awaited call, then run the rest of that model's group in
  // parallel. Ignored by non-Anthropic candidates.
  cachedPrefix?: string;
  // Optional exact validation after the provider-safe transport schema.
  // A failure participates in the same bounded provider retry/failover as a
  // native schema miss. Segment topology lanes omit this callback because
  // their callers feed the issues into a corrective semantic prompt.
  validateOutput?: (output: T) => void;
}

class StructuredOutputValidationError extends Error {}

function buildMessages(cachedPrefix: string, prompt: string) {
  return [
    {
      content: [
        {
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" as const } },
          },
          text: cachedPrefix,
          type: "text" as const,
        },
        { text: prompt, type: "text" as const },
      ],
      role: "user" as const,
    },
  ];
}

// A schema-mismatch response ("No object generated: response did not match
// schema") is usually one-off model noise, not a broken prompt — observed
// on staging 2026-08-25 when the extraction qa pass missed the schema on
// attempt 1 and passed cleanly on retry. One bounded same-candidate retry
// absorbs it at the call site (warm prompt cache, cheap) instead of failing
// the whole task run. Budget exhaustion (finishReason "length") is
// deliberately NOT retried: that is a route-sizing bug and must stay loud.
const SCHEMA_MISS_RETRIES = 1;

function isRetryableSchemaMiss(error: unknown): boolean {
  return (
    (NoObjectGeneratedError.isInstance(error) &&
      error.finishReason !== "length") ||
    error instanceof StructuredOutputValidationError
  );
}

// OpenRouter reports the real billed cost in provider metadata when usage
// accounting is on (the provider seam enables it on every OpenRouter
// candidate); Anthropic costs come from our own price table instead.
function openRouterCostUsd(providerMetadata: unknown): number | null {
  const cost = (
    providerMetadata as
      | { openrouter?: { usage?: { cost?: number } } }
      | undefined
  )?.openrouter?.usage?.cost;
  return typeof cost === "number" ? cost : null;
}

function candidateCostUsd(
  candidate: { modelId: string; provider: string },
  inputTokens: number,
  outputTokens: number,
  providerMetadata: unknown
): number | null {
  return candidate.provider === "anthropic"
    ? estimateCostUsd(candidate.modelId, inputTokens, outputTokens)
    : openRouterCostUsd(providerMetadata);
}

function anthropicGenerationOptions(
  route: ReturnType<typeof routeForTask>,
  structuredOutputMode?: GenerateStructuredOptions["anthropicStructuredOutputMode"]
) {
  return {
    ...(route.effort && EFFORT_TIERS.has(route.tier)
      ? { effort: route.effort }
      : {}),
    ...(structuredOutputMode ? { structuredOutputMode } : {}),
  };
}

function validateStructuredOutput<T>(
  output: T,
  validateOutput?: (output: T) => void
): T {
  if (!validateOutput) {
    return output;
  }
  try {
    validateOutput(output);
    return output;
  } catch (error) {
    throw new StructuredOutputValidationError(
      error instanceof Error ? error.message : "Output failed validation",
      { cause: error }
    );
  }
}

export async function generateStructured<T>(
  task: AiTask,
  system: string,
  prompt: string,
  schema: z.ZodType<T>,
  options?: GenerateStructuredOptions<T>
): Promise<StructuredResult<T>> {
  const route = routeForTask(task);
  const candidates = await getModelCandidates(task);
  if (candidates.length === 0) {
    throw new Error("No AI provider configured");
  }

  logTelemetryStateOnce();

  let lastError: unknown;
  const attempts = candidates.flatMap((candidate) =>
    Array.from({ length: SCHEMA_MISS_RETRIES + 1 }, (_, retry) => ({
      candidate,
      retry,
    }))
  );
  for (const { candidate, retry } of attempts) {
    // Retry slots only run when the previous failure on this candidate was
    // a retryable schema miss; anything else falls through to the next
    // candidate immediately.
    if (retry > 0 && !isRetryableSchemaMiss(lastError)) {
      continue;
    }
    try {
      const anthropicOptions = anthropicGenerationOptions(
        route,
        options?.anthropicStructuredOutputMode
      );
      // biome-ignore lint/performance/noAwaitInLoops: candidates are tried strictly in order
      const result = await generateObject({
        experimental_telemetry: {
          functionId: task,
          isEnabled: true,
        },
        maxOutputTokens: route.maxOutputTokens,
        // biome-ignore lint/suspicious/noExplicitAny: MastraModelConfig is wider than the AI SDK model union; candidates only ever hold AI SDK model instances
        model: candidate.model as any,
        schema,
        system,
        // Adaptive-thinking effort from the task route — sent ONLY for
        // tiers that accept it (haiku-4-5 rejects the parameter with a
        // hard API error; staging 2026-08-24). Ignored by non-Anthropic
        // candidates — providerOptions are per-provider.
        ...(Object.keys(anthropicOptions).length > 0
          ? { providerOptions: { anthropic: anthropicOptions } }
          : {}),
        ...(options?.cachedPrefix
          ? { messages: buildMessages(options.cachedPrefix, prompt) }
          : { prompt }),
      });
      const inputTokens = result.usage.inputTokens ?? 0;
      const outputTokens = result.usage.outputTokens ?? 0;
      const output = validateStructuredOutput(
        schema.parse(result.object),
        options?.validateOutput
      );
      return {
        output,
        usage: {
          costUsd: candidateCostUsd(
            candidate,
            inputTokens,
            outputTokens,
            result.providerMetadata
          ),
          inputTokens,
          model: candidate.modelId,
          outputTokens,
          provider: candidate.provider,
          task,
        },
      };
    } catch (error) {
      // A budget-exhausted response is a sizing bug, not a provider flake —
      // name it so the failure row points at the fix (staging 2026-08-24:
      // a truncated claims pass surfaced only as "could not parse").
      lastError =
        NoObjectGeneratedError.isInstance(error) &&
        error.finishReason === "length"
          ? new Error(
              `${task} exhausted its output budget (maxOutputTokens=${route.maxOutputTokens}, thinking counts against it)`,
              { cause: error }
            )
          : error;
      console.error(`[ai] ${task} failed on ${candidate.provider}:`, error);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Every provider failed for ${task}`);
}
