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
  // The Cutter (docs/clip-cut-architecture.md §4 Pass 3): one small call
  // per clip over a ±90s sentence-ID reel — the fine cut. Sonnet at
  // medium effort; budget = tiny ID payload + reasoning + thinking
  // headroom (sonnet thinks by default and thinking counts).
  "clip-fine.cut": {
    effort: "medium",
    maxOutputTokens: 3000,
    tier: "sonnet",
  },
  // The Director (§4 Pass 1): the episode brief — spine, marquee arcs,
  // drop zones — over the shared cached prefix. Opus: this is the pass
  // where "plan like a real editor" lives, and the LAST place to
  // economize. Budget: spine ≤40 + arcs ≤12 + drops ≤24 rows of short
  // fields ≈ 4-5k payload + thinking headroom.
  "episode-brief.compose": {
    maxOutputTokens: 12_000,
    tier: "opus",
  },
  // LLM-as-judge scorers for the golden evals.
  "evals.judge": {
    maxOutputTokens: 2000,
    tier: "sonnet",
  },
  // Moment discovery (S6): ONE pass proposing clip-worthy candidates over
  // the cached transcript prefix — editorial judgment, sonnet. Budget math
  // (the S5 rule — thinking counts against maxOutputTokens): schema bound
  // 24 items × ~650 tokens/item worst case (780 chars of capped text
  // fields ≈ 200 tokens, + span/scores/keys ≈ 100, + up to 8 seed UUIDs ≈
  // 220 — UUIDs tokenize expensively) ≈ 15.6k payload + thinking. The old
  // 24k assumed ~350/item and truncated twice in production before
  // succeeding (run_06g3q3jk4jkei3tj5opum9qe01, 2026-08-26: two attempts
  // capped at exactly 24k output, the third needed ~19.6k) — same lesson
  // as the claims pass (#76), same remedy: bound every field (seedIds got
  // its .max(8) with this change) and size the cap for the bounded worst
  // case, ~15.6k + ~12k thinking headroom over the observed high-water →
  // 32k. Budgets are allowances — only real tokens bill.
  // Opus by default since the nine-model audition (2026-08-26 verdict,
  // AGENTS.md): only model top-tier in both clip lanes, and CHEAPER than
  // sonnet per run (6.8k output tokens vs 16-22k — it thinks less to
  // decide). The env override below remains the audition path.
  "moment-discovery.candidates": {
    maxOutputTokens: 32_000,
    tier: "opus",
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
  // Segment plan (S6.5): ONE pass proposing the episode's full keep/drop
  // partition over the cached prefix — the Editor half of the clip
  // harness. Budget math, recomputed honestly after the discovery route's
  // ~350/item estimate truncated in production (2026-08-26): a maxed KEEP
  // row is ~270 tokens (780 chars of capped text ≈ 200, + span/kind/keys
  // ≈ 70), a drop row ~70 (nulled text + reason), so even the
  // self-contradictory all-64-maxed-keeps ceiling is ~17k payload — a real
  // plan alternates keeps with tiny drop rows and sits well under that —
  // + thinking headroom (a 2.5h episode legitimately yields a long plan)
  // → 32k holds. Default effort — the coverage plan is core-bet editorial
  // judgment.
  // Opus by default — the audition verdict, same as moment discovery.
  "segment-plan.partition": {
    maxOutputTokens: 32_000,
    tier: "opus",
  },
  // Global chapter Reconciler: one full-episode pass over the rough plan,
  // removing false boundaries before the fine Cutter spends calls placing
  // the survivors. Opus shares the rough pass's cached transcript prefix;
  // the large cap covers an exact ordered grouping plus adaptive thinking.
  "segment-plan.reconcile": {
    maxOutputTokens: 32_000,
    tier: "opus",
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

// Per-task tier override via env — the model A/B switch for the quality
// program (M1 finding 2026-08-26: candidate taste, not boundaries, is the
// open question, and this table's own header has always said editorial
// judgment rides Opus). Raw env reads outside serverEnvSchema (the
// standing precedent); an invalid value is ignored, never a boot failure.
// Flip it in the Trigger env, re-run the pass, judge the sets blind.
// Two accepted forms, told apart by the "/" every OpenRouter id carries:
// a first-party tier name ("opus"), or an OpenRouter model slug
// ("moonshotai/kimi-k3") — the third-party audition path.
const TIER_OVERRIDE_ENV: Partial<Record<AiTask, string>> = {
  "clip-fine.cut": "CLIP_FINE_TIER",
  "episode-brief.compose": "EPISODE_BRIEF_TIER",
  "moment-discovery.candidates": "MOMENT_DISCOVERY_TIER",
  "moment-review.verdict": "MOMENT_REVIEW_TIER",
  "segment-plan.partition": "SEGMENT_PLAN_TIER",
  "segment-plan.reconcile": "SEGMENT_PLAN_TIER",
};

function isModelTier(value: string): value is ModelTier {
  return value in MODEL_TIERS;
}

// OpenRouter ids: author/model, occasionally with a variant suffix
// (":batch") or a leading "~" alias.
const OPENROUTER_SLUG = /^[\w~][\w.~-]*\/[\w.~:-]+$/;

export type ResolvedRoute = TaskRoute & {
  // Set when the override names an OpenRouter model. The provider seam
  // then makes OpenRouter the ONLY candidate — a silent first-party
  // fallback mid-audition would produce a mislabeled A/B set — and effort
  // is dropped (an Anthropic-only parameter). The table row still supplies
  // maxOutputTokens.
  openrouterModel?: string;
};

export function routeForTask(task: AiTask): ResolvedRoute {
  const route: TaskRoute = TASK_ROUTES[task];
  const envVar = TIER_OVERRIDE_ENV[task];
  const override = envVar ? process.env[envVar] : undefined;
  if (!override) {
    return route;
  }
  if (isModelTier(override)) {
    if (override === route.tier) {
      return route;
    }
    // Effort must not survive onto a tier that rejects the parameter (the
    // haiku hard-API-error lesson).
    if (route.effort && !EFFORT_TIERS.has(override)) {
      const { effort: _effort, ...rest } = route;
      return { ...rest, tier: override };
    }
    return { ...route, tier: override };
  }
  if (OPENROUTER_SLUG.test(override)) {
    const { effort: _effort, ...rest } = route;
    return { ...rest, openrouterModel: override };
  }
  return route;
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
