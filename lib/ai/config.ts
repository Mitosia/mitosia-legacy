// Model tiering (tech-stack §7, thesis §27.2): every AI task routes through
// this table, never a hardcoded model string at a call site. Cheap broad
// passes ride Haiku, writing/evaluation rides Sonnet, editorial judgment
// (S6+) rides Opus. Per-tenant overrides arrive when entitlements do —
// the table shape already keys by task so that lands here, not in callers.

export const MODEL_TIERS = {
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
} as const;
export type ModelTier = keyof typeof MODEL_TIERS;

export interface TaskRoute {
  // Reasoning effort for the task (Anthropic adaptive thinking). Omit for
  // provider default ("high"); "low" for mechanical extraction passes.
  effort?: "low" | "medium" | "high";
  maxOutputTokens: number;
  tier: ModelTier;
}

// One row per AI task the product performs. S4 ships source analysis; S5+
// tasks append rows rather than inventing new plumbing.
export const TASK_ROUTES = {
  // LLM-as-judge scorers for the golden evals.
  "evals.judge": {
    maxOutputTokens: 2000,
    tier: "sonnet",
  },
  // Chapters/topics over a full transcript: broad, structured, cheap.
  "source-analysis.chapters": {
    effort: "low",
    maxOutputTokens: 8000,
    tier: "haiku",
  },
  // Summary, entities, and speaker intelligence: editorial quality matters,
  // and the speaker-merge suggestions carry real product risk if sloppy.
  "source-analysis.editorial": {
    // Generous: adaptive thinking counts against the output budget, and a
    // 2.5h interview legitimately produces a long entity/speaker inventory
    maxOutputTokens: 16_000,
    tier: "sonnet",
  },
} as const;
export type AiTask = keyof typeof TASK_ROUTES;

export function routeForTask(task: AiTask): TaskRoute {
  return TASK_ROUTES[task];
}

// USD per million tokens (first-party list prices, 2026-08). Used only for
// the estimated-cost metadata on ledger entries — billing truth is the
// provider invoice; this is the "cost per source-hour" visibility the S4
// exit criterion asks for.
export const MODEL_PRICING_PER_MTOK: Record<
  (typeof MODEL_TIERS)[ModelTier],
  { input: number; output: number }
> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
};

// Embedding models bill on input tokens only. voyage-4 verified 2026-08-24
// ($0.06/M, 200M free tokens per account — pre-alpha volume is free).
export const EMBEDDING_PRICING_PER_MTOK: Record<string, number> = {
  "voyage-4": 0.06,
};

export function estimateEmbeddingCostUsd(
  modelId: string,
  tokens: number
): number | null {
  const pricing = EMBEDDING_PRICING_PER_MTOK[modelId];
  return pricing === undefined ? null : (tokens * pricing) / 1_000_000;
}

export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number | null {
  const pricing =
    MODEL_PRICING_PER_MTOK[modelId as keyof typeof MODEL_PRICING_PER_MTOK];
  if (!pricing) {
    return null;
  }
  return (
    (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
  );
}
