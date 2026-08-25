import { generateObject, NoObjectGeneratedError } from "ai";
import type { z } from "zod";
import {
  type AiTask,
  EFFORT_TIERS,
  estimateCostUsd,
  MODEL_TIERS,
  routeForTask,
} from "./config";
import { getModelCandidates } from "./provider";

// Structured generation through the seam: AI SDK generateObject — NATIVE
// single-pass structured output — with ordered provider failover and usage
// accounting. Deliberately not Mastra's agent.generate({structuredOutput}):
// that path runs a second-pass "structuring agent" that re-extracts the
// first pass's free text into the schema, and on staging (2026-08-23,
// Karma source) it silently filled unmappable fields with literal
// "placeholder" strings that passed schema validation. Native structured
// output is one model call: cheaper, deterministic, and it either returns
// the schema or throws.
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

export interface GenerateStructuredOptions {
  // A shared prefix (context + transcript) cached across sibling calls via
  // an Anthropic cache breakpoint. Callers making several passes over the
  // same long document put the document here and only the per-pass
  // instructions in `prompt` — and must keep `system`, the schema, and this
  // prefix IDENTICAL across the group, because tools/output-format and
  // system precede messages in the cache key. Caches are per-model: prime
  // with one awaited call, then run the rest of that model's group in
  // parallel. Ignored by non-Anthropic candidates.
  cachedPrefix?: string;
}

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
    NoObjectGeneratedError.isInstance(error) && error.finishReason !== "length"
  );
}

export async function generateStructured<T>(
  task: AiTask,
  system: string,
  prompt: string,
  schema: z.ZodType<T>,
  options?: GenerateStructuredOptions
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
        ...(route.effort && EFFORT_TIERS.has(route.tier)
          ? { providerOptions: { anthropic: { effort: route.effort } } }
          : {}),
        ...(options?.cachedPrefix
          ? { messages: buildMessages(options.cachedPrefix, prompt) }
          : { prompt }),
      });
      const inputTokens = result.usage.inputTokens ?? 0;
      const outputTokens = result.usage.outputTokens ?? 0;
      return {
        output: schema.parse(result.object),
        usage: {
          costUsd: estimateCostUsd(
            MODEL_TIERS[route.tier],
            inputTokens,
            outputTokens
          ),
          inputTokens,
          model: MODEL_TIERS[route.tier],
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
