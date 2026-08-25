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

// Which tiers accept the `effort` parameter. claude-haiku-4-5 REJECTS it
// with "This model does not support the effort parameter" — a hard API
// error, learned on staging 2026-08-24 when the first wired-effort call
// failed every extraction. generateStructured gates on this, and the
// config test asserts no route declares effort on an unsupported tier.
export const EFFORT_TIERS: ReadonlySet<ModelTier> = new Set(["sonnet", "opus"]);

export interface TaskRoute {
  // Reasoning effort (Anthropic adaptive thinking) — only meaningful on
  // EFFORT_TIERS; omit for the provider default ("high").
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
  // Moment discovery (S6): ONE pass proposing clip-worthy candidates over
  // the cached transcript prefix — editorial judgment, sonnet. Budget math
  // (the S5 rule — thinking counts against maxOutputTokens): schema bound
  // 24 items × ~350 tokens/item (span + title/hook/summary/anchor +
  // scores) ≈ 8.5k payload + generous adaptive-thinking headroom ≈ well
  // under 24k, so the pass cannot truncate.
  "moment-discovery.candidates": {
    maxOutputTokens: 24_000,
    tier: "sonnet",
  },
  // Cold-context reviewer verdict (S6 §9): one SMALL call per candidate
  // clip — input is only the clip's own span + title (a few k tokens, no
  // cached prefix), output is four 0-2 rubric scores + a short note.
  // Sonnet at medium effort: editorial judgment on a small artifact;
  // budget = tiny payload (~150 tokens) + thinking headroom.
  "moment-review.verdict": {
    effort: "medium",
    maxOutputTokens: 2000,
    tier: "sonnet",
  },
  // Chapters/topics over a full transcript: broad, structured, cheap.
  // No effort: haiku rejects the parameter (see EFFORT_TIERS).
  "source-analysis.chapters": {
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
  // Extraction passes (S5): three sonnet passes share one cached transcript
  // prefix + one schema (see lib/ai/capabilities/source-extraction.ts); the
  // qa pass rides haiku — mechanical span-spotting, not editorial judgment.
  // Sonnet budgets are sized for ADAPTIVE THINKING + payload, not payload
  // alone: sonnet-5 thinks by default and thinking counts against
  // max_tokens — the stories pass at 8k returned NOTHING on a dense 2.5h
  // staging source because thinking consumed the whole budget before any
  // JSON (staging 2026-08-24; the S4 editorial route learned the same
  // lesson). Budgets are allowances, not spend — only real tokens bill.
  // Claims is the widest pass: the shared schema's 48-item bound × ~520
  // tokens/item + thinking ≈ 30k worst case, so 32k cannot truncate.
  // effort: "medium" on all three sonnet passes (S6 cost checkpoint,
  // 2026-08-25): thinking dominates extraction spend ($15/M output) and
  // the golden eval holds full deterministic parity at medium — budgets
  // stay sized for worst case, effort trims the real spend inside them.
  // Claims-on-haiku was ALSO eval-tested: deterministic parity on the
  // small fixture, but not adopted — staging showed haiku's verbatim
  // grounding is content-dependent (fo547 qa grounded 0/…), and the
  // committed fixture is too small to rule that out for the marquee pass.
  "source-extraction.claims": {
    effort: "medium",
    maxOutputTokens: 32_000,
    tier: "sonnet",
  },
  // No effort: haiku rejects the parameter (see EFFORT_TIERS); haiku
  // runs no thinking, so this budget is payload-only.
  "source-extraction.qa": {
    maxOutputTokens: 12_000,
    tier: "haiku",
  },
  "source-extraction.quotes": {
    effort: "medium",
    maxOutputTokens: 24_000,
    tier: "sonnet",
  },
  "source-extraction.stories": {
    effort: "medium",
    maxOutputTokens: 24_000,
    tier: "sonnet",
  },
  // Interactive source Q&A over retrieved chunks: a small prompt, but the
  // answer is user-facing prose with citations — sonnet quality.
  "source-qa.answer": {
    maxOutputTokens: 4000,
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
