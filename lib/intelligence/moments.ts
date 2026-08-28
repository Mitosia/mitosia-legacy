import type { TranscriptWord } from "@/lib/transcription/types";
import { alignExtraction, tokenizeWords } from "./grounding";

// Deterministic post-processing for moment discovery (S6): the model
// proposes, this file disposes (D3). Boundary snapping to the sentence
// grid, anchor grounding through the S5 aligner, range/embedding dedupe,
// composite scoring, ranking — all pure functions, all unit-tested, no
// model judgment anywhere. Client-safe (the review UI's nudge buttons
// import the sentence-grid helpers).
//
// Boundary snapping is word-timeline math on purpose (AGENTS §Source
// intelligence, S5 finding): punctuated words are sentence boundaries and
// inter-word gaps are pause detection — no ffmpeg silence/energy pass.

// A word ends a sentence when it ends with terminal punctuation, optionally
// followed by closing quotes/brackets — the per-word form of scoreSummary's
// SENTENCE_END heuristic.
const SENTENCE_TERMINAL = /[.!?]["”'’)\]]*$/u;

// An inter-word gap this long reads as a pause a cut can land on.
export const DEFAULT_PAUSE_GAP_MS = 700;

// A bad model range must not swallow extra audio: snapping may grow a
// boundary outward by at most this much per side before falling back.
export const SNAP_MAX_GROWTH_MS = 10_000;

// risk at or above this gets the Sensitive badge — a flag for the
// reviewer, never an exclusion.
export const SENSITIVE_RISK_THRESHOLD = 0.6;

// Range-overlap dedupe: above this IoU two candidates are the same moment.
export const DEDUPE_IOU_THRESHOLD = 0.5;
// Semantic dedupe (the "same story told twice" case): cosine between the
// candidates' mean chunk vectors at or above this joins the group.
export const DEDUPE_COSINE_THRESHOLD = 0.92;

export interface MomentScores {
  comprehensibility: number;
  hook: number;
  insight: number;
  relevance: number;
  risk: number;
}

// Composite deliberately excludes risk — it's a flag, not a demerit.
// Weights are a starting point; M1 review data (acceptance vs. per-
// dimension scores) retunes them post-gate.
export const MOMENT_COMPOSITE_WEIGHTS = {
  comprehensibility: 0.2,
  hook: 0.3,
  insight: 0.25,
  relevance: 0.25,
} as const;

export function compositeScore(scores: MomentScores): number {
  return (
    MOMENT_COMPOSITE_WEIGHTS.hook * scores.hook +
    MOMENT_COMPOSITE_WEIGHTS.insight * scores.insight +
    MOMENT_COMPOSITE_WEIGHTS.comprehensibility * scores.comprehensibility +
    MOMENT_COMPOSITE_WEIGHTS.relevance * scores.relevance
  );
}

// Word indices where a sentence begins: the first word, and every word
// whose predecessor ends with terminal punctuation.
export function sentenceStarts(words: readonly TranscriptWord[]): number[] {
  const starts: number[] = [];
  for (let index = 0; index < words.length; index += 1) {
    if (index === 0) {
      starts.push(0);
      continue;
    }
    const previous = words[index - 1];
    if (previous && SENTENCE_TERMINAL.test(previous.text)) {
      starts.push(index);
    }
  }
  return starts;
}

// Word indices preceded by an inter-word silence of at least minGapMs.
export function pauseBoundaries(
  words: readonly TranscriptWord[],
  minGapMs: number = DEFAULT_PAUSE_GAP_MS
): number[] {
  const boundaries: number[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const word = words[index];
    if (previous && word && word.startMs - previous.endMs >= minGapMs) {
      boundaries.push(index);
    }
  }
  return boundaries;
}

export interface MsRange {
  endMs: number;
  startMs: number;
}

// Snap-point times derived from the word timeline. A sentence START plays
// from its first word's startMs; a sentence END stops at its last word's
// endMs (the word before the next start, or the final word).
export function sentenceStartTimes(words: readonly TranscriptWord[]): number[] {
  return sentenceStarts(words)
    .map((index) => words[index]?.startMs)
    .filter((time): time is number => time !== undefined);
}

export function sentenceEndTimes(words: readonly TranscriptWord[]): number[] {
  const starts = sentenceStarts(words);
  const times: number[] = [];
  for (const start of starts) {
    if (start === 0) {
      continue;
    }
    const previous = words[start - 1];
    if (previous) {
      times.push(previous.endMs);
    }
  }
  const last = words.at(-1);
  if (last) {
    times.push(last.endMs);
  }
  return times;
}

// Largest candidate time at-or-before `at`, within the growth cap.
function snapDown(times: readonly number[], at: number): number | null {
  let best: number | null = null;
  for (const time of times) {
    if (time <= at && at - time <= SNAP_MAX_GROWTH_MS) {
      best = best === null ? time : Math.max(best, time);
    }
  }
  return best;
}

// Smallest candidate time at-or-after `at`, within the growth cap.
function snapUp(times: readonly number[], at: number): number | null {
  let best: number | null = null;
  for (const time of times) {
    if (time >= at && time - at <= SNAP_MAX_GROWTH_MS) {
      best = best === null ? time : Math.min(best, time);
    }
  }
  return best;
}

// Snap a model-claimed range onto the sentence grid: the start moves to the
// nearest sentence start at-or-before it (a mid-sentence in-point plays a
// half sentence), the end to the nearest sentence end at-or-after. Pause
// boundaries are the fallback when no sentence boundary sits within the
// growth cap; failing both, the raw (clamped) bound is kept — snapping
// must never invent a worse range than the model's.
export function snapToSentences(
  range: MsRange,
  words: readonly TranscriptWord[],
  pauseGapMs: number = DEFAULT_PAUSE_GAP_MS
): MsRange {
  const [first] = words;
  const last = words.at(-1);
  if (!(first && last)) {
    return range;
  }
  const startAt = Math.max(range.startMs, first.startMs);
  const endAt = Math.min(range.endMs, last.endMs);

  const pauses = pauseBoundaries(words, pauseGapMs);
  const pauseStartTimes = pauses
    .map((index) => words[index]?.startMs)
    .filter((time): time is number => time !== undefined);
  const pauseEndTimes = pauses
    .map((index) => words[index - 1]?.endMs)
    .filter((time): time is number => time !== undefined);

  const startMs =
    snapDown(sentenceStartTimes(words), startAt) ??
    snapDown(pauseStartTimes, startAt) ??
    startAt;
  const endMs =
    snapUp(sentenceEndTimes(words), endAt) ??
    snapUp(pauseEndTimes, endAt) ??
    endAt;

  // A degenerate snap (range collapsed by clamping) keeps the clamped raw
  // bounds so downstream validity checks can reject it honestly.
  if (endMs <= startMs) {
    return { endMs: endAt, startMs: startAt };
  }
  return { endMs, startMs };
}

// Lead-in capture (the Brett Lee finding, staging 2026-08-25): a moment
// that opens with one speaker answering owes its meaning to the short
// other-speaker turn right before it — the interviewer's question or
// setup. The model anchors on the answer (that's where the anchor text
// lives) and sentence-snapping cannot reason about conversation structure,
// so the span started mid-exchange and the clip opened without its
// context. Deterministic rule: when the immediately preceding turn is by a
// DIFFERENT speaker, short enough to be a prompt, and close enough to be
// part of the exchange, the span grows to include it.
export const LEAD_IN_MAX_TURN_MS = 20_000;
export const LEAD_IN_MAX_GAP_MS = 3000;

export function captureLeadIn(
  range: MsRange,
  words: readonly TranscriptWord[]
): MsRange {
  const openerIndex = words.findIndex((word) => word.startMs >= range.startMs);
  if (openerIndex <= 0) {
    return range;
  }
  const opener = words[openerIndex];
  const previous = words[openerIndex - 1];
  if (!(opener && previous)) {
    return range;
  }
  // Same speaker before the opener = mid-monologue start (snapping's job),
  // and unknown speakers give the rule nothing to reason with.
  if (
    opener.speaker === null ||
    previous.speaker === null ||
    previous.speaker === opener.speaker
  ) {
    return range;
  }
  if (opener.startMs - previous.endMs > LEAD_IN_MAX_GAP_MS) {
    return range;
  }
  // Walk back to where the preceding speaker's turn began.
  let turnStart = openerIndex - 1;
  while (turnStart > 0 && words[turnStart - 1]?.speaker === previous.speaker) {
    turnStart -= 1;
  }
  const first = words[turnStart];
  if (!first) {
    return range;
  }
  // A long preceding turn is the other speaker's own moment, not a setup.
  if (previous.endMs - first.startMs > LEAD_IN_MAX_TURN_MS) {
    return range;
  }
  return { endMs: range.endMs, startMs: first.startMs };
}

// Display-form text of exactly one range — what a viewer of that clip
// hears, and therefore the ENTIRE context the cold reviewer receives.
export function spanText(
  words: readonly TranscriptWord[],
  range: MsRange
): string {
  return words
    .filter(
      (word) => word.startMs >= range.startMs && word.startMs < range.endMs
    )
    .map((word) => word.text)
    .join(" ");
}

// Times where a speaker turn begins — lead-in starts land here, so they
// belong to the valid boundary grid alongside sentence starts.
export function speakerTurnStartTimes(
  words: readonly TranscriptWord[]
): number[] {
  const times: number[] = [];
  for (const [index, word] of words.entries()) {
    if (index === 0 || words[index - 1]?.speaker !== word.speaker) {
      times.push(word.startMs);
    }
  }
  return times;
}

export interface AnchorGrounding {
  endMs: number;
  grounded: boolean;
  score: number;
  startMs: number;
}

// The provenance gate (D3): the anchor phrase must align verbatim AND land
// inside the snapped range — an anchor found elsewhere means the range and
// the claim disagree, and the candidate never surfaces.
export function groundMomentAnchor(
  anchorText: string,
  snapped: MsRange,
  timedTokens: ReturnType<typeof tokenizeWords>
): AnchorGrounding {
  const aligned = alignExtraction(
    anchorText,
    snapped.startMs,
    snapped.endMs,
    timedTokens
  );
  return {
    endMs: aligned.endMs,
    grounded:
      aligned.grounded &&
      aligned.startMs >= snapped.startMs &&
      aligned.endMs <= snapped.endMs,
    score: aligned.score,
    startMs: aligned.startMs,
  };
}

function rangeIou(a: MsRange, b: MsRange): number {
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  if (overlap <= 0) {
    return 0;
  }
  const union = Math.max(a.endMs, b.endMs) - Math.min(a.startMs, b.startMs);
  return union <= 0 ? 0 : overlap / union;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [i, value] of a.entries()) {
    const other = b[i] ?? 0;
    dot += value * other;
    normA += value * value;
    normB += other * other;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

export interface DedupeChunk {
  embedding: readonly number[];
  endMs: number;
  startMs: number;
}

// Indices of the chunks a candidate's range overlaps — its semantic
// footprint. The footprint's mean vector stands in for "what this moment
// is about".
function chunkFootprint(
  range: MsRange,
  chunks: readonly DedupeChunk[]
): number[] {
  const indices: number[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.startMs < range.endMs && chunk.endMs > range.startMs) {
      indices.push(index);
    }
  }
  return indices;
}

function meanVector(
  indices: readonly number[],
  chunks: readonly DedupeChunk[]
): number[] | null {
  const [firstIndex] = indices;
  const firstChunk = firstIndex === undefined ? null : chunks[firstIndex];
  if (!firstChunk) {
    return null;
  }
  const mean = new Array<number>(firstChunk.embedding.length).fill(0);
  for (const index of indices) {
    for (const [i, value] of (chunks[index]?.embedding ?? []).entries()) {
      mean[i] = (mean[i] ?? 0) + value;
    }
  }
  return mean.map((value) => value / indices.length);
}

interface UnionFind {
  find: (index: number) => number;
  union: (a: number, b: number) => void;
}

function createUnionFind(size: number): UnionFind {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root] ?? root;
    }
    return root;
  };
  return {
    find,
    union: (a: number, b: number) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) {
        parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
      }
    },
  };
}

export interface DedupeInput extends MsRange {
  composite: number;
}

export interface DedupeVerdict {
  dedupeGroup: number | null;
  suppressed: boolean;
}

// Two passes into one union-find: range IoU (the same span claimed twice),
// then mean-chunk-vector cosine (the same story told TWICE APART in
// different words — the diamond-merchant case). The cosine pass only
// considers pairs whose ranges are disjoint AND whose chunk footprints
// differ: overlapping ranges are the IoU pass's job, and two short moments
// inside the same chunk share one footprint vector by construction —
// merging them would collapse distinct beats, not duplicates. Per group,
// the highest composite survives; the rest are suppressed but kept for
// instrumentation. Without chunks (index not ready) the cosine pass is
// skipped — IoU still runs.
function unionOverlappingRanges(
  candidates: readonly DedupeInput[],
  uf: UnionFind
): void {
  for (let a = 0; a < candidates.length; a += 1) {
    for (let b = a + 1; b < candidates.length; b += 1) {
      const left = candidates[a];
      const right = candidates[b];
      if (left && right && rangeIou(left, right) > DEDUPE_IOU_THRESHOLD) {
        uf.union(a, b);
      }
    }
  }
}

function semanticPair(
  candidates: readonly MsRange[],
  footprints: readonly number[][],
  vectors: readonly (number[] | null)[],
  a: number,
  b: number
): boolean {
  const left = candidates[a];
  const right = candidates[b];
  const vectorA = vectors[a];
  const vectorB = vectors[b];
  if (!(left && right && vectorA && vectorB)) {
    return false;
  }
  if (rangeIou(left, right) > 0) {
    return false;
  }
  if (footprints[a]?.join(",") === footprints[b]?.join(",")) {
    return false;
  }
  return cosine(vectorA, vectorB) >= DEDUPE_COSINE_THRESHOLD;
}

function unionSemanticDuplicates(
  candidates: readonly DedupeInput[],
  chunks: readonly DedupeChunk[],
  uf: UnionFind
): void {
  const footprints = candidates.map((candidate) =>
    chunkFootprint(candidate, chunks)
  );
  const vectors = footprints.map((footprint) => meanVector(footprint, chunks));
  for (let a = 0; a < candidates.length; a += 1) {
    for (let b = a + 1; b < candidates.length; b += 1) {
      if (semanticPair(candidates, footprints, vectors, a, b)) {
        uf.union(a, b);
      }
    }
  }
}

function verdictsFromGroups(
  candidates: readonly DedupeInput[],
  uf: UnionFind
): DedupeVerdict[] {
  const members = new Map<number, number[]>();
  for (let index = 0; index < candidates.length; index += 1) {
    const root = uf.find(index);
    const list = members.get(root) ?? [];
    list.push(index);
    members.set(root, list);
  }

  const verdicts: DedupeVerdict[] = candidates.map(() => ({
    dedupeGroup: null,
    suppressed: false,
  }));
  let nextGroup = 0;
  for (const list of members.values()) {
    if (list.length < 2) {
      continue;
    }
    const group = nextGroup;
    nextGroup += 1;
    let keeper = list[0] ?? 0;
    for (const index of list) {
      if (
        (candidates[index]?.composite ?? 0) >
        (candidates[keeper]?.composite ?? 0)
      ) {
        keeper = index;
      }
    }
    for (const index of list) {
      verdicts[index] = { dedupeGroup: group, suppressed: index !== keeper };
    }
  }
  return verdicts;
}

// The semantic pass alone, as pairs — the segment planner flags
// twice-told stories (both survive; a flag, never suppression) with the
// exact same footprint/cosine rules the moment dedupe uses.
export function semanticTwinPairs(
  ranges: readonly MsRange[],
  chunks: readonly DedupeChunk[]
): [number, number][] {
  if (chunks.length === 0) {
    return [];
  }
  const footprints = ranges.map((range) => chunkFootprint(range, chunks));
  const vectors = footprints.map((footprint) => meanVector(footprint, chunks));
  const pairs: [number, number][] = [];
  for (let a = 0; a < ranges.length; a += 1) {
    for (let b = a + 1; b < ranges.length; b += 1) {
      if (semanticPair(ranges, footprints, vectors, a, b)) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

export function dedupeCandidates(
  candidates: readonly DedupeInput[],
  chunks: readonly DedupeChunk[]
): DedupeVerdict[] {
  const uf = createUnionFind(candidates.length);
  unionOverlappingRanges(candidates, uf);
  if (chunks.length > 0) {
    unionSemanticDuplicates(candidates, chunks, uf);
  }
  return verdictsFromGroups(candidates, uf);
}

// ---- Full post-process ----------------------------------------------------

export interface RawMomentCandidate {
  anchorText: string;
  endMs: number;
  hook: string;
  scores: MomentScores;
  seedIds: string[];
  startMs: number;
  summary: string;
  title: string;
}

// One insertable candidate row, minus the org/source/run/revision ids the
// pipeline attaches.
export interface MomentRow {
  anchorText: string;
  composite: number;
  dedupeGroup: number | null;
  endMs: number;
  // Deterministic observability flags (stale_open, lead_out_trimmed,
  // unrefined, …) — docs/clip-cut-architecture.md §5. Inform, never
  // auto-reject.
  flags: string[];
  grounded: boolean;
  groundingScore: number;
  hook: string;
  rank: number;
  rawEndMs: number;
  rawStartMs: number;
  scores: MomentScores;
  seedIds: string[];
  sensitive: boolean;
  startMs: number;
  summary: string;
  suppressed: boolean;
  title: string;
}

// The whole deterministic gauntlet, in gate order: clamp → snap → ground →
// score → dedupe (grounded rows only — ungrounded rows never surface, so
// they must not suppress a real candidate) → rank. Rank order is grounded
// survivors by composite, then suppressed duplicates, then ungrounded rows
// — the table keeps everything, the UI defaults to the first slice.
export function buildMomentRows(
  items: readonly RawMomentCandidate[],
  words: readonly TranscriptWord[],
  durationMs: number,
  chunks: readonly DedupeChunk[]
): MomentRow[] {
  const tokens = tokenizeWords(words);

  const processed = items.map((item) => {
    const rawStartMs = Math.max(0, Math.min(item.startMs, durationMs));
    const rawEndMs = Math.max(rawStartMs, Math.min(item.endMs, durationMs));
    // Lead-in capture no longer runs here: the Cutter layer's two-turn
    // question-aware backstop (grid.ts captureLeadInTwoTurn) is the single
    // lead-in authority — applying both compounded, walking further back
    // on every pass. captureLeadIn stays exported for the review UI's
    // client-side helpers and its own tests.
    const snapped = snapToSentences(
      { endMs: rawEndMs, startMs: rawStartMs },
      words
    );
    const anchor = groundMomentAnchor(item.anchorText, snapped, tokens);
    return {
      anchorText: item.anchorText,
      composite: compositeScore(item.scores),
      dedupeGroup: null as number | null,
      endMs: snapped.endMs,
      flags: [] as string[],
      grounded: anchor.grounded && snapped.endMs > snapped.startMs,
      groundingScore: anchor.score,
      hook: item.hook,
      rank: 0,
      rawEndMs,
      rawStartMs,
      scores: item.scores,
      seedIds: item.seedIds,
      sensitive: item.scores.risk >= SENSITIVE_RISK_THRESHOLD,
      startMs: snapped.startMs,
      summary: item.summary,
      suppressed: false,
      title: item.title,
    };
  });

  return dedupeAndRankMomentRows(processed, chunks);
}

// Dedupe + strata ranking, callable again after the Cutter or the
// revision round moves boundaries (refined boundaries can converge two
// candidates — re-running IoU here is what keeps a converged pair from
// shipping twice). Resets prior verdicts before re-applying.
export function dedupeAndRankMomentRows(
  rows: MomentRow[],
  chunks: readonly DedupeChunk[]
): MomentRow[] {
  for (const row of rows) {
    row.dedupeGroup = null;
    row.suppressed = false;
  }
  const grounded = rows.filter((row) => row.grounded);
  const verdicts = dedupeCandidates(grounded, chunks);
  for (const [index, verdict] of verdicts.entries()) {
    const row = grounded[index];
    if (row) {
      row.dedupeGroup = verdict.dedupeGroup;
      row.suppressed = verdict.suppressed;
    }
  }

  const byComposite = (a: MomentRow, b: MomentRow) => b.composite - a.composite;
  const ordered = [
    ...rows.filter((row) => row.grounded && !row.suppressed).sort(byComposite),
    ...rows.filter((row) => row.grounded && row.suppressed).sort(byComposite),
    ...rows.filter((row) => !row.grounded).sort(byComposite),
  ];
  for (const [rank, row] of ordered.entries()) {
    row.rank = rank;
  }
  return ordered;
}
