// Provider-neutral model routing. OpenRouter is the only active transport,
// while this registry keeps model identity and capabilities out of callers.
// Every production id is an explicit model revision/family id: aliases such
// as `openrouter/auto`, `~vendor/*-latest`, and `:free` never appear here.

export type ReasoningEffort = "high" | "low" | "medium";
export type PromptCachingMode = "automatic" | "explicit" | "none";
export type ModelFamily = "anthropic" | "google" | "moonshot" | "openai";

export interface ModelCapabilities {
  promptCaching: PromptCachingMode;
  reasoningEffort: boolean;
  structuredOutputs: boolean;
}

export interface ModelDefinition {
  capabilities: ModelCapabilities;
  family: ModelFamily;
  id: string;
}

const EXPLICIT_CACHE_CAPABILITIES = {
  promptCaching: "explicit",
  reasoningEffort: true,
  structuredOutputs: true,
} as const satisfies ModelCapabilities;

const AUTOMATIC_CACHE_CAPABILITIES = {
  promptCaching: "automatic",
  reasoningEffort: true,
  structuredOutputs: true,
} as const satisfies ModelCapabilities;

export const OPENROUTER_MODELS = {
  claudeHaiku: {
    capabilities: {
      ...EXPLICIT_CACHE_CAPABILITIES,
      // Haiku 4.5 has rejected effort on the proven production path. Keep
      // the adapter conservative instead of asking OpenRouter to translate it.
      reasoningEffort: false,
    },
    family: "anthropic",
    id: "anthropic/claude-haiku-4.5",
  },
  claudeOpus: {
    capabilities: EXPLICIT_CACHE_CAPABILITIES,
    family: "anthropic",
    id: "anthropic/claude-opus-5",
  },
  claudeSonnet: {
    capabilities: EXPLICIT_CACHE_CAPABILITIES,
    family: "anthropic",
    id: "anthropic/claude-sonnet-5",
  },
  geminiPro: {
    capabilities: AUTOMATIC_CACHE_CAPABILITIES,
    family: "google",
    id: "google/gemini-3.1-pro-preview",
  },
  gptSol: {
    capabilities: AUTOMATIC_CACHE_CAPABILITIES,
    family: "openai",
    id: "openai/gpt-5.6-sol",
  },
  kimiK3: {
    capabilities: {
      ...AUTOMATIC_CACHE_CAPABILITIES,
      // Kimi reasons natively, but OpenRouter does not promise that every
      // eligible endpoint accepts a portable effort level.
      reasoningEffort: false,
    },
    family: "moonshot",
    id: "moonshotai/kimi-k3",
  },
} as const satisfies Record<string, ModelDefinition>;

export type RegisteredModel =
  (typeof OPENROUTER_MODELS)[keyof typeof OPENROUTER_MODELS];

// Candidate order is a Mitosia editorial decision. OpenRouter may fail over
// between upstream endpoints for one model, while generateStructured may move
// to the next model in this list only after the current candidate fails.
export const MODEL_PROFILES = {
  balanced: [
    OPENROUTER_MODELS.claudeSonnet.id,
    OPENROUTER_MODELS.gptSol.id,
    OPENROUTER_MODELS.geminiPro.id,
    OPENROUTER_MODELS.kimiK3.id,
  ],
  // Independent publishing critic. The supervising Editor starts with
  // Claude; the verifier deliberately starts in another model family. The
  // pipeline additionally excludes the winning Editor's whole family, so a
  // fallback Editor still never grades its own work.
  critic: [
    OPENROUTER_MODELS.gptSol.id,
    OPENROUTER_MODELS.geminiPro.id,
    OPENROUTER_MODELS.claudeOpus.id,
    OPENROUTER_MODELS.kimiK3.id,
  ],
  editorial: [
    OPENROUTER_MODELS.claudeOpus.id,
    OPENROUTER_MODELS.gptSol.id,
    OPENROUTER_MODELS.geminiPro.id,
    OPENROUTER_MODELS.kimiK3.id,
  ],
  efficient: [
    OPENROUTER_MODELS.claudeHaiku.id,
    OPENROUTER_MODELS.geminiPro.id,
    OPENROUTER_MODELS.gptSol.id,
    OPENROUTER_MODELS.kimiK3.id,
  ],
} as const;
export type ModelProfile = keyof typeof MODEL_PROFILES;

// Kept only so existing imports and `*_TIER=haiku|sonnet|opus` deployment
// configuration continue to resolve during migration. Task routes no longer
// use tiers, and all three ids are sent through OpenRouter.
export const MODEL_TIERS = {
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
} as const;
export type ModelTier = keyof typeof MODEL_TIERS;
export const EFFORT_TIERS: ReadonlySet<ModelTier> = new Set(["sonnet", "opus"]);

const LEGACY_TIER_MODEL_IDS: Record<ModelTier, string> = {
  haiku: OPENROUTER_MODELS.claudeHaiku.id,
  opus: OPENROUTER_MODELS.claudeOpus.id,
  sonnet: OPENROUTER_MODELS.claudeSonnet.id,
};

export interface TaskRoute {
  maxOutputTokens: number;
  profile: ModelProfile;
  reasoningEffort?: ReasoningEffort;
  requiredCapabilities: readonly (keyof ModelCapabilities)[];
}

const STRUCTURED_OUTPUT_REQUIRED = ["structuredOutputs"] as const;

// One row per AI task the product performs. S4 ships source analysis; S5+
// tasks append rows rather than inventing new plumbing.
export const TASK_ROUTES = {
  // The Cutter (docs/clip-cut-architecture.md §4 Pass 3): one small call
  // per clip over a ±90s sentence-ID reel — the fine cut. Sonnet at
  // medium effort; budget = tiny ID payload + reasoning + thinking
  // headroom (sonnet thinks by default and thinking counts).
  "clip-fine.cut": {
    maxOutputTokens: 3000,
    profile: "balanced",
    reasoningEffort: "medium",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  // The Director (§4 Pass 1): the episode brief — spine, marquee arcs,
  // drop zones — over the shared cached prefix. Opus: this is the pass
  // where "plan like a real editor" lives, and the LAST place to
  // economize. Budget: spine ≤40 + arcs ≤12 + drops ≤24 rows of short
  // fields ≈ 4-5k payload + thinking headroom.
  "episode-brief.compose": {
    maxOutputTokens: 12_000,
    profile: "editorial",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  // LLM-as-judge scorers for the golden evals.
  "evals.judge": {
    maxOutputTokens: 2000,
    profile: "balanced",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
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
    profile: "editorial",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  // Cold-context reviewer verdict (S6 §9): one SMALL call per candidate
  // clip — input is only the clip's own span + title (a few k tokens, no
  // cached prefix), output is four 0-2 rubric scores + a short note.
  // Sonnet at medium effort: editorial judgment on a small artifact;
  // budget = tiny payload (~150 tokens) + thinking headroom.
  "moment-review.verdict": {
    maxOutputTokens: 2000,
    profile: "balanced",
    reasoningEffort: "medium",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
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
    profile: "editorial",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  // Global chapter Reconciler: one full-episode pass over the rough plan,
  // removing false boundaries before the fine Cutter spends calls placing
  // the survivors. Opus shares the rough pass's cached transcript prefix;
  // the large cap covers an exact ordered grouping plus adaptive thinking.
  "segment-plan.reconcile": {
    maxOutputTokens: 32_000,
    profile: "editorial",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  // Final whole-episode Publisher Editor. It receives the complete compiled
  // draft at sentence-ID resolution and may merge, split, redistribute,
  // reclassify, or repackage it as one coherent replacement partition.
  "segment-publisher.edit": {
    maxOutputTokens: 32_000,
    profile: "editorial",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  // Independent whole-plan verifier. It starts with GPT and the caller
  // excludes the Editor winner's entire family. A verifier emits verdicts,
  // never a new cut, so 24k leaves ample reasoning and payload headroom.
  "segment-publisher.verify": {
    maxOutputTokens: 24_000,
    profile: "critic",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  // Chapters/topics over a full transcript: broad, structured, cheap.
  // No effort: haiku rejects the parameter (see EFFORT_TIERS).
  "source-analysis.chapters": {
    maxOutputTokens: 8000,
    profile: "efficient",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  // Summary, entities, and speaker intelligence: editorial quality matters,
  // and the speaker-merge suggestions carry real product risk if sloppy.
  "source-analysis.editorial": {
    // Generous: adaptive thinking counts against the output budget, and a
    // 2.5h interview legitimately produces a long entity/speaker inventory
    maxOutputTokens: 16_000,
    profile: "balanced",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
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
    maxOutputTokens: 32_000,
    profile: "balanced",
    reasoningEffort: "medium",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  // No effort: haiku rejects the parameter (see EFFORT_TIERS); haiku
  // runs no thinking, so this budget is payload-only.
  "source-extraction.qa": {
    maxOutputTokens: 12_000,
    profile: "efficient",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  "source-extraction.quotes": {
    maxOutputTokens: 24_000,
    profile: "balanced",
    reasoningEffort: "medium",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  "source-extraction.stories": {
    maxOutputTokens: 24_000,
    profile: "balanced",
    reasoningEffort: "medium",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
  // Interactive source Q&A over retrieved chunks: a small prompt, but the
  // answer is user-facing prose with citations — sonnet quality.
  "source-qa.answer": {
    maxOutputTokens: 4000,
    profile: "balanced",
    requiredCapabilities: STRUCTURED_OUTPUT_REQUIRED,
  },
} as const;
export type AiTask = keyof typeof TASK_ROUTES;

interface ModelOverrideEnv {
  candidates: string;
  legacyTier: string;
}

// `*_MODELS` is the provider-neutral override: one explicit OpenRouter slug,
// or an ordered comma-separated candidate list. `*_TIER` remains accepted so
// existing Trigger/Dokploy configuration does not change behavior abruptly.
// Invalid values are ignored, never a boot failure.
const MODEL_OVERRIDE_ENV: Partial<Record<AiTask, ModelOverrideEnv>> = {
  "clip-fine.cut": {
    candidates: "CLIP_FINE_MODELS",
    legacyTier: "CLIP_FINE_TIER",
  },
  "episode-brief.compose": {
    candidates: "EPISODE_BRIEF_MODELS",
    legacyTier: "EPISODE_BRIEF_TIER",
  },
  "moment-discovery.candidates": {
    candidates: "MOMENT_DISCOVERY_MODELS",
    legacyTier: "MOMENT_DISCOVERY_TIER",
  },
  "moment-review.verdict": {
    candidates: "MOMENT_REVIEW_MODELS",
    legacyTier: "MOMENT_REVIEW_TIER",
  },
  "segment-plan.partition": {
    candidates: "SEGMENT_PLAN_MODELS",
    legacyTier: "SEGMENT_PLAN_TIER",
  },
  "segment-plan.reconcile": {
    candidates: "SEGMENT_PLAN_MODELS",
    legacyTier: "SEGMENT_PLAN_TIER",
  },
  "segment-publisher.edit": {
    candidates: "SEGMENT_PUBLISHER_EDITOR_MODELS",
    legacyTier: "SEGMENT_PUBLISHER_EDITOR_TIER",
  },
  "segment-publisher.verify": {
    candidates: "SEGMENT_PUBLISHER_VERIFIER_MODELS",
    legacyTier: "SEGMENT_PUBLISHER_VERIFIER_TIER",
  },
};

function isModelTier(value: string): value is ModelTier {
  return value in MODEL_TIERS;
}

// Explicit OpenRouter ids: author/model, optionally with a pinned variant
// suffix such as `:batch`. Moving aliases are deliberately rejected so an
// eval or rerun cannot silently change models between executions.
const OPENROUTER_SLUG = /^[\w][\w.~-]*\/[\w][\w.~:-]+$/;
const MOVING_ALIAS = /(^|[.:-])latest($|[.:-])/i;

function parseExplicitCandidates(value: string | undefined): string[] | null {
  if (!value) {
    return null;
  }
  const candidates = value
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (
    candidates.length === 0 ||
    candidates.some(
      (candidate) =>
        !OPENROUTER_SLUG.test(candidate) ||
        candidate === "openrouter/auto" ||
        candidate.startsWith("~") ||
        MOVING_ALIAS.test(candidate)
    )
  ) {
    return null;
  }
  return [...new Set(candidates)];
}

const MODEL_BY_ID = new Map<string, ModelDefinition>(
  Object.values(OPENROUTER_MODELS).map((model) => [model.id, model])
);

export function modelDefinitionFor(
  modelId: string
): ModelDefinition | undefined {
  return MODEL_BY_ID.get(modelId);
}

// Explicit deployment overrides may name a newer model that is not yet in
// the curated registry. OpenRouter's vendor prefix is still a safe family
// boundary, so an Anthropic override cannot accidentally be reviewed by a
// different Anthropic model. Unknown vendors get their own stable namespace.
export function modelFamilyFor(modelId: string): string {
  const definition = MODEL_BY_ID.get(modelId);
  if (definition !== undefined) {
    return definition.family;
  }
  const vendor = modelId.split("/", 1)[0]?.trim().toLowerCase();
  if (!vendor) {
    return `model:${modelId}`;
  }
  if (vendor === "moonshotai") {
    return "moonshot";
  }
  if (["anthropic", "google", "openai"].includes(vendor)) {
    return vendor;
  }
  return `openrouter-vendor:${vendor}`;
}

export type ResolvedRoute = TaskRoute & {
  modelIds: readonly string[];
};

export function routeForTask(task: AiTask): ResolvedRoute {
  const route: TaskRoute = TASK_ROUTES[task];
  const overrideEnv = MODEL_OVERRIDE_ENV[task];
  const explicitCandidates = parseExplicitCandidates(
    overrideEnv ? process.env[overrideEnv.candidates] : undefined
  );
  if (explicitCandidates) {
    return { ...route, modelIds: explicitCandidates };
  }

  const legacyOverride = overrideEnv
    ? process.env[overrideEnv.legacyTier]?.trim()
    : undefined;
  if (legacyOverride && isModelTier(legacyOverride)) {
    return { ...route, modelIds: [LEGACY_TIER_MODEL_IDS[legacyOverride]] };
  }
  const legacyCandidates = parseExplicitCandidates(legacyOverride);
  if (legacyCandidates) {
    return { ...route, modelIds: legacyCandidates };
  }

  return { ...route, modelIds: MODEL_PROFILES[route.profile] };
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
