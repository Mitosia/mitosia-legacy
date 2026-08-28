import type {
  ChaptersOutput,
  EditorialOutput,
} from "@/lib/ai/capabilities/source-analysis";
import {
  pauseBoundaries,
  sentenceEndTimes,
  sentenceStartTimes,
  speakerTurnStartTimes,
} from "@/lib/intelligence/moments";
import type { TranscriptWord } from "@/lib/transcription/types";

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

// Extraction grounding score (S5): the share of extracted items whose
// claimed-verbatim text actually aligns to the transcript word timeline —
// measured with the SAME aligner that gates production rows, so the eval
// measures exactly what ships. Fabricated spans and mangled quotes are the
// failure mode this exists to catch.
export function scoreExtractions(
  rows: readonly {
    endMs: number;
    grounded: boolean;
    kind: string;
    startMs: number;
  }[],
  durationMs: number
): ScoreReport {
  const issues: string[] = [];
  if (rows.length === 0) {
    return { issues: ["no extractions produced"], score: 0 };
  }

  const grounded = rows.filter((row) => row.grounded);
  const groundingRate = grounded.length / rows.length;
  if (groundingRate < 1) {
    issues.push(
      `${rows.length - grounded.length}/${rows.length} items failed verbatim grounding`
    );
  }

  let rangesValid = true;
  for (const row of grounded) {
    if (row.endMs <= row.startMs || row.endMs > durationMs) {
      rangesValid = false;
      issues.push(`${row.kind} range ${row.startMs}-${row.endMs} is invalid`);
    }
  }

  const kinds = new Set(rows.map((row) => row.kind));
  if (kinds.size < 2) {
    issues.push(`only ${[...kinds].join(", ") || "nothing"} extracted`);
  }

  let score = groundingRate;
  if (!rangesValid) {
    score *= 0.5;
  }
  if (kinds.size < 2) {
    score *= 0.8;
  }
  return { issues, score };
}

// Moment-discovery score (S6): grounded rate is the base — the same
// provenance bar as extraction — with deterministic structure checks
// layered on: snapped bounds must land on the sentence/pause grid, no
// surviving pair may overlap past the dedupe threshold, durations should
// sit in clip range, dimension scores must be in [0,1]. Penalties are
// sized so a perfectly-grounded run with short moments (a short fixture)
// still passes, while off-grid bounds or a dedupe miss fails outright.
const MOMENT_MIN_DURATION_MS = 10_000;
const MOMENT_MAX_DURATION_MS = 120_000;
const MOMENT_DURATION_RATE = 0.8;
const MOMENT_IOU_LIMIT = 0.5;

interface ScoredMoment {
  endMs: number;
  grounded: boolean;
  scores: {
    comprehensibility: number;
    hook: number;
    insight: number;
    relevance: number;
    risk: number;
  };
  startMs: number;
  suppressed: boolean;
}

function momentIou(a: ScoredMoment, b: ScoredMoment): number {
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  if (overlap <= 0) {
    return 0;
  }
  return (
    overlap / (Math.max(a.endMs, b.endMs) - Math.min(a.startMs, b.startMs))
  );
}

function checkMomentGrid(
  survivors: readonly ScoredMoment[],
  durationMs: number,
  words: readonly TranscriptWord[],
  issues: string[]
): boolean {
  const pauses = pauseBoundaries(words);
  // Speaker-turn starts are valid in-points too: lead-in capture opens a
  // moment at the setup question, which begins where its speaker's turn
  // does — not necessarily on a sentence boundary of the previous speaker.
  const validStarts = new Set([
    ...sentenceStartTimes(words),
    ...speakerTurnStartTimes(words),
    ...pauses.map((index) => words[index]?.startMs),
  ]);
  const validEnds = new Set([
    ...sentenceEndTimes(words),
    ...pauses.map((index) => words[index - 1]?.endMs),
  ]);
  let onGrid = true;
  for (const row of survivors) {
    if (!(validStarts.has(row.startMs) && validEnds.has(row.endMs))) {
      onGrid = false;
      issues.push(
        `bounds ${row.startMs}-${row.endMs} are off the sentence grid`
      );
    }
    if (row.endMs <= row.startMs || row.endMs > durationMs) {
      onGrid = false;
      issues.push(`range ${row.startMs}-${row.endMs} is invalid`);
    }
  }
  return onGrid;
}

function checkMomentOverlaps(
  survivors: readonly ScoredMoment[],
  issues: string[]
): boolean {
  let deduped = true;
  for (let a = 0; a < survivors.length; a += 1) {
    for (let b = a + 1; b < survivors.length; b += 1) {
      const left = survivors[a];
      const right = survivors[b];
      if (left && right && momentIou(left, right) > MOMENT_IOU_LIMIT) {
        deduped = false;
        issues.push("surviving candidates overlap past the dedupe threshold");
      }
    }
  }
  return deduped;
}

export function scoreMoments(
  rows: readonly ScoredMoment[],
  durationMs: number,
  words: readonly TranscriptWord[]
): ScoreReport {
  if (rows.length === 0) {
    return { issues: ["no candidates produced"], score: 0 };
  }
  const issues: string[] = [];
  const groundedRate = rows.filter((row) => row.grounded).length / rows.length;
  if (groundedRate < 1) {
    issues.push(
      `${rows.length - rows.filter((row) => row.grounded).length}/${rows.length} anchors failed grounding`
    );
  }
  const survivors = rows.filter((row) => row.grounded && !row.suppressed);
  const onGrid = checkMomentGrid(survivors, durationMs, words, issues);
  const deduped = checkMomentOverlaps(survivors, issues);

  const inClipRange = survivors.filter((row) => {
    const duration = row.endMs - row.startMs;
    return (
      duration >= MOMENT_MIN_DURATION_MS && duration <= MOMENT_MAX_DURATION_MS
    );
  });
  const durationOk =
    survivors.length === 0 ||
    inClipRange.length / survivors.length >= MOMENT_DURATION_RATE;
  if (!durationOk) {
    issues.push(
      `only ${inClipRange.length}/${survivors.length} moments are 10-120s`
    );
  }

  const scoresValid = rows.every((row) =>
    Object.values(row.scores).every((value) => value >= 0 && value <= 1)
  );
  if (!scoresValid) {
    issues.push("dimension scores fall outside 0-1");
  }

  let score = groundedRate;
  if (!onGrid) {
    score *= 0.5;
  }
  if (!deduped) {
    score *= 0.5;
  }
  if (!durationOk) {
    score *= 0.85;
  }
  if (!scoresValid) {
    score *= 0.9;
  }
  return { issues, score };
}

// Segment-plan score (S6.5): the coverage lane's deterministic gate.
// Base = grounded rate over keeps; hard penalties for a broken partition
// (the coverage invariant is the product), missing drop reasons, or
// non-chronological rows. No duration checks at all — the constraint
// policy (2026-08-26): length is the content's call, outliers are
// reviewer-facing flags, never scorer penalties.
interface ScoredSegment {
  dropReason: string | null;
  endMs: number;
  grounded: boolean;
  kind: string;
  startMs: number;
}

export function scoreSegments(
  rows: readonly ScoredSegment[],
  partitionOk: boolean
): ScoreReport {
  if (rows.length === 0) {
    return { issues: ["no segments produced"], score: 0 };
  }
  const issues: string[] = [];
  const keeps = rows.filter((row) => row.kind === "keep");
  if (keeps.length === 0) {
    return { issues: ["plan kept nothing"], score: 0 };
  }
  const groundedRate =
    keeps.filter((row) => row.grounded).length / keeps.length;
  if (groundedRate < 1) {
    issues.push(
      `${keeps.length - keeps.filter((row) => row.grounded).length}/${keeps.length} keeps failed anchor grounding`
    );
  }
  if (!partitionOk) {
    issues.push("rows do not tile the episode");
  }
  const unreasonedDrops = rows.filter(
    (row) => row.kind === "drop" && row.dropReason === null
  ).length;
  if (unreasonedDrops > 0) {
    issues.push(`${unreasonedDrops} drop(s) carry no reason`);
  }
  let chronological = true;
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (previous && current && current.startMs < previous.endMs) {
      chronological = false;
    }
  }
  if (!chronological) {
    issues.push("rows overlap or are out of order");
  }

  let score = groundedRate;
  if (!partitionOk) {
    score *= 0.5;
  }
  if (!chronological) {
    score *= 0.5;
  }
  if (unreasonedDrops > 0) {
    score *= 0.9;
  }
  return { issues, score };
}

// Semantic chapter-boundary gold is intentionally independent of duration.
// A fixture labels selected boundaries in its numbered rough atom plan as
// KEEP (two independently selectable topics) or REMOVE (one continuous
// topic). The Reconciler's exact-cover groups imply the prediction: adjacent
// atoms in the same group remove their shared boundary; different groups keep
// it. Fixtures may label only high-confidence boundaries, so the scorer is
// bounded to the supplied gold rather than inventing judgments elsewhere.
export interface SegmentBoundaryDecision {
  afterAtomId: string;
  keep: boolean;
  note?: string;
}

interface SegmentBoundaryAtom {
  atomId: string;
}

interface SegmentBoundaryGroup {
  atomIds: readonly string[];
}

export function segmentBoundaryDecisions(
  atoms: readonly SegmentBoundaryAtom[],
  groups: readonly SegmentBoundaryGroup[]
): SegmentBoundaryDecision[] {
  const groupByAtom = new Map<string, number>();
  for (const [groupIndex, group] of groups.entries()) {
    for (const atomId of group.atomIds) {
      if (groupByAtom.has(atomId)) {
        throw new Error(`atom ${atomId} appears in more than one group`);
      }
      groupByAtom.set(atomId, groupIndex);
    }
  }
  for (const atom of atoms) {
    if (!groupByAtom.has(atom.atomId)) {
      throw new Error(`atom ${atom.atomId} is missing from reconciliation`);
    }
  }

  return atoms.slice(0, -1).map((atom, index) => {
    const right = atoms[index + 1];
    if (!right) {
      throw new Error("segment boundary has no right atom");
    }
    return {
      afterAtomId: atom.atomId,
      keep: groupByAtom.get(atom.atomId) !== groupByAtom.get(right.atomId),
    };
  });
}

export function scoreSegmentBoundaries(
  predicted: readonly SegmentBoundaryDecision[],
  gold: readonly SegmentBoundaryDecision[]
): ScoreReport {
  if (gold.length === 0) {
    return { issues: ["no segment-boundary gold"], score: 0 };
  }

  const issues: string[] = [];
  const predictedById = new Map<string, boolean>();
  for (const decision of predicted) {
    if (predictedById.has(decision.afterAtomId)) {
      issues.push(`duplicate prediction after ${decision.afterAtomId}`);
      continue;
    }
    predictedById.set(decision.afterAtomId, decision.keep);
  }

  const seenGold = new Set<string>();
  const totals = new Map<boolean, number>();
  const correct = new Map<boolean, number>();
  for (const expected of gold) {
    if (seenGold.has(expected.afterAtomId)) {
      issues.push(`duplicate gold boundary after ${expected.afterAtomId}`);
      continue;
    }
    seenGold.add(expected.afterAtomId);
    totals.set(expected.keep, (totals.get(expected.keep) ?? 0) + 1);
    const actual = predictedById.get(expected.afterAtomId);
    if (actual === expected.keep) {
      correct.set(expected.keep, (correct.get(expected.keep) ?? 0) + 1);
      continue;
    }
    const note = expected.note ? ` (${expected.note})` : "";
    if (actual === undefined) {
      issues.push(`no prediction after ${expected.afterAtomId}${note}`);
    } else if (actual) {
      issues.push(
        `kept boundary after ${expected.afterAtomId} that gold removes${note}`
      );
    } else {
      issues.push(
        `removed boundary after ${expected.afterAtomId} that gold keeps${note}`
      );
    }
  }

  // Macro-average the represented classes. A plan that keeps every rough
  // boundary cannot hide its fragmentation behind a more numerous KEEP
  // class, and a plan that merges everything is penalized symmetrically.
  const classScores = [...totals.entries()].map(
    ([keep, total]) => (correct.get(keep) ?? 0) / total
  );
  const score =
    classScores.reduce((sum, classScore) => sum + classScore, 0) /
    classScores.length;
  return { issues, score };
}

// Q&A golden score (S5): per fixture question, full credit when the
// answerability verdict matches AND (for answerable ones) some verified
// citation overlaps the gold range; the verdict alone earns half. Both
// halves of the exit test — honest misses and playable evidence — are in
// the same number.
export interface QaOutcome {
  // Answer text and citation quotes ride along for the LLM
  // citation-relevance judge; the deterministic score ignores them.
  answer?: string;
  citations: { endMs: number; quote?: string; startMs: number }[];
  expectedAnswerable: boolean;
  goldEndMs?: number;
  goldStartMs?: number;
  gotAnswerable: boolean;
  question: string;
}

export function scoreQa(outcomes: readonly QaOutcome[]): ScoreReport {
  if (outcomes.length === 0) {
    return { issues: ["no golden questions"], score: 0 };
  }
  const issues: string[] = [];
  let total = 0;
  for (const outcome of outcomes) {
    if (outcome.gotAnswerable !== outcome.expectedAnswerable) {
      issues.push(
        `"${outcome.question}": expected answerable=${outcome.expectedAnswerable}`
      );
      continue;
    }
    if (!outcome.expectedAnswerable) {
      total += 1;
      continue;
    }
    const hits = outcome.citations.some(
      (citation) =>
        citation.startMs < (outcome.goldEndMs ?? 0) &&
        citation.endMs > (outcome.goldStartMs ?? 0)
    );
    if (hits) {
      total += 1;
    } else {
      total += 0.5;
      issues.push(`"${outcome.question}": no citation overlaps the gold range`);
    }
  }
  return { issues, score: total / outcomes.length };
}
