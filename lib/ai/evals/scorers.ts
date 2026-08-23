import type {
  ChaptersOutput,
  EditorialOutput,
} from "@/lib/ai/capabilities/source-analysis";

// Deterministic scorers for the source-analysis golden evals: pure
// functions, no model calls, so they run anywhere (unit tests, pnpm eval,
// CI) and gate before the expensive LLM judge — the guardrail ordering
// from tech-stack §7 (deterministic checkers first, model evaluators
// second).

export interface ScoreReport {
  issues: string[];
  // 0..1 — thresholds live in the eval runner, not here
  score: number;
}

export function scoreChapters(
  chapters: ChaptersOutput["chapters"],
  durationMs: number
): ScoreReport {
  const issues: string[] = [];
  if (chapters.length === 0) {
    return { issues: ["no chapters"], score: 0 };
  }

  let coveredMs = 0;
  let ordered = true;
  for (const [index, chapter] of chapters.entries()) {
    coveredMs += chapter.endMs - chapter.startMs;
    const previous = chapters[index - 1];
    if (previous && chapter.startMs < previous.endMs) {
      ordered = false;
    }
    if (chapter.title.trim().length === 0) {
      issues.push(`chapter ${index} has an empty title`);
    }
  }
  const coverage = Math.min(coveredMs / durationMs, 1);
  if (coverage < 0.8) {
    issues.push(`chapters cover only ${(coverage * 100).toFixed(0)}%`);
  }
  if (!ordered) {
    issues.push("chapters overlap or are out of order");
  }
  const lastEnd = chapters.at(-1)?.endMs ?? 0;
  if (lastEnd < durationMs * 0.9) {
    issues.push("last chapter ends well before the recording does");
  }

  let score = coverage;
  if (!ordered) {
    score *= 0.5;
  }
  if (issues.some((issue) => issue.includes("empty title"))) {
    score *= 0.8;
  }
  return { issues, score };
}

export function scoreSpeakerSuggestions(
  suggestions: EditorialOutput["speakers"],
  transcriptSpeakerIds: readonly string[]
): ScoreReport {
  const issues: string[] = [];
  const known = new Set(transcriptSpeakerIds);
  const covered = new Set<string>();

  for (const suggestion of suggestions) {
    covered.add(suggestion.speaker);
    if (!known.has(suggestion.speaker)) {
      issues.push(`suggestion for unknown speaker id ${suggestion.speaker}`);
    }
    if (suggestion.mergeWith !== null && !known.has(suggestion.mergeWith)) {
      issues.push(`merge target ${suggestion.mergeWith} is not a speaker id`);
    }
    if (suggestion.suggestedName && suggestion.evidence.trim().length === 0) {
      issues.push(`name for speaker ${suggestion.speaker} carries no evidence`);
    }
  }
  for (const id of known) {
    if (!covered.has(id)) {
      issues.push(`speaker id ${id} has no suggestion entry`);
    }
  }

  const score =
    known.size === 0
      ? 1
      : Math.max(0, 1 - issues.length / Math.max(known.size, 1));
  return { issues, score };
}

const SENTENCE_END = /[.!?](\s|$)/g;

export function scoreSummary(summary: string): ScoreReport {
  const issues: string[] = [];
  const sentences = (summary.match(SENTENCE_END) ?? []).length;
  if (summary.trim().length < 100) {
    issues.push("summary is too short to be an executive summary");
  }
  if (sentences < 2) {
    issues.push("summary has fewer than 2 sentences");
  }
  if (sentences > 10) {
    issues.push("summary rambles past 10 sentences");
  }
  if (summary.includes("#") || summary.includes("**")) {
    issues.push("summary contains markdown formatting");
  }
  return { issues, score: issues.length === 0 ? 1 : 0.5 / issues.length };
}
