import { generateObject } from "ai";
import type { z } from "zod";
import {
  type AiTask,
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

export async function generateStructured<T>(
  task: AiTask,
  system: string,
  prompt: string,
  schema: z.ZodType<T>
): Promise<StructuredResult<T>> {
  const route = routeForTask(task);
  const candidates = await getModelCandidates(task);
  if (candidates.length === 0) {
    throw new Error("No AI provider configured");
  }

  logTelemetryStateOnce();

  let lastError: unknown;
  for (const candidate of candidates) {
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
        prompt,
        schema,
        system,
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
      lastError = error;
      console.error(`[ai] ${task} failed on ${candidate.provider}:`, error);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Every provider failed for ${task}`);
}
