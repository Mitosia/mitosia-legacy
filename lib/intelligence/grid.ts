import type { TranscriptWord } from "@/lib/transcription/types";
import {
  DEFAULT_PAUSE_GAP_MS,
  LEAD_IN_MAX_GAP_MS,
  LEAD_IN_MAX_TURN_MS,
  type MsRange,
  sentenceStarts,
} from "./moments";

// The cut-point substrate (docs/clip-cut-architecture.md §4 Pass 0): the
// addressable timeline every clip pass selects from. The model never emits
// a millisecond — it selects enumerated sentence/paragraph IDs from the
// renderings built here, and `resolveSpan` maps IDs back to exact word
// times. Pure, deterministic, client-safe, unit-tested.
//
// Two granularities:
// - SENTENCES (fine): the Cutter's coordinate system. Each carries turn/
//   question/pause annotations so narrative backstops can be semantic.
// - PARAGRAPHS (coarse): the rough passes' coordinate system — a paragraph
//   is 30-90s of one speaker developing one thought, so chapter cuts
//   proposed at paragraph altitude resist beat-slicing by construction.

// A sentence whose display text ends with '?' (before closing quotes) is
// question-shaped — the semantic upgrade for lead-in/lead-out backstops.
const QUESTION_TERMINAL = /\?["”'’)\]]*$/u;

// Paragraph packing mirrors the viewer's grouping (speaker change / long
// silence / size cap) but tiles SENTENCES, never splitting one.
const PARAGRAPH_GAP_MS = 2500;
const PARAGRAPH_MAX_WORDS = 120;

// Cutter window sizing (§4 Pass 3): rough span ± margin, then expanded to
// whole turns — at least the two preceding complete turns and one
// following turn, so two-turn setups and lead-outs are inside the window
// by construction.
export const CUTTER_MARGIN_MS = 90_000;
const CUTTER_PRECEDING_TURNS = 2;
const CUTTER_FOLLOWING_TURNS = 1;

// Shot-snap dead zone (§7): a boundary landing within this of a shot
// change moves ONTO it — never near it — and only over silence.
export const SHOT_SNAP_MS = 500;

export interface GridSentence {
  endMs: number;
  // Position of this sentence within its speaker turn
  endsTurn: boolean;
  endWord: number;
  id: number;
  opensTurn: boolean;
  // Silence after this sentence's last word (0 for the final sentence)
  pauseAfterMs: number;
  question: boolean;
  speaker: string | null;
  startMs: number;
  startWord: number;
  text: string;
}

export interface GridParagraph {
  endMs: number;
  endSentence: number;
  id: number;
  speaker: string | null;
  startMs: number;
  startSentence: number;
}

export interface CutGrid {
  paragraphs: GridParagraph[];
  sentences: GridSentence[];
  words: readonly TranscriptWord[];
}

function sentenceRanges(
  words: readonly TranscriptWord[]
): { end: number; start: number }[] {
  const starts = sentenceStarts(words);
  return starts.map((start, index) => ({
    end: (starts[index + 1] ?? words.length) - 1,
    start,
  }));
}

export function buildCutGrid(words: readonly TranscriptWord[]): CutGrid {
  const sentences: GridSentence[] = sentenceRanges(words).map(
    (range, index) => {
      const first = words[range.start];
      const last = words[range.end];
      const before = words[range.start - 1];
      const after = words[range.end + 1];
      const text = words
        .slice(range.start, range.end + 1)
        .map((word) => word.text)
        .join(" ");
      return {
        endMs: last?.endMs ?? 0,
        endsTurn: after === undefined || after.speaker !== last?.speaker,
        endWord: range.end,
        id: index,
        opensTurn: before === undefined || before.speaker !== first?.speaker,
        pauseAfterMs: after
          ? Math.max(0, after.startMs - (last?.endMs ?? 0))
          : 0,
        question: QUESTION_TERMINAL.test(last?.text ?? ""),
        speaker: first?.speaker ?? null,
        startMs: first?.startMs ?? 0,
        startWord: range.start,
        text,
      };
    }
  );

  const paragraphs: GridParagraph[] = [];
  let current: GridParagraph | null = null;
  let currentWords = 0;
  for (const sentence of sentences) {
    const sentenceWords = sentence.endWord - sentence.startWord + 1;
    const gapMs =
      current === null
        ? 0
        : sentence.startMs - (sentences[sentence.id - 1]?.endMs ?? 0);
    const breaks =
      current === null ||
      sentence.speaker !== current.speaker ||
      gapMs > PARAGRAPH_GAP_MS ||
      currentWords + sentenceWords > PARAGRAPH_MAX_WORDS;
    if (breaks || current === null) {
      current = {
        endMs: sentence.endMs,
        endSentence: sentence.id,
        id: paragraphs.length,
        speaker: sentence.speaker,
        startMs: sentence.startMs,
        startSentence: sentence.id,
      };
      paragraphs.push(current);
      currentWords = sentenceWords;
    } else {
      current.endMs = sentence.endMs;
      current.endSentence = sentence.id;
      currentWords += sentenceWords;
    }
  }

  return { paragraphs, sentences, words };
}

export interface ResolvedSpan extends MsRange {
  // True when an out-of-range ID had to be clamped — surfaced as a flag,
  // never a silent repair.
  clamped: boolean;
}

function clampId(grid: CutGrid, id: number): number {
  return Math.max(0, Math.min(Math.round(id), grid.sentences.length - 1));
}

// ID → ms is a lookup, not a search: the span plays from the in sentence's
// first word to the out sentence's last word. Invalid or inverted IDs
// clamp and flag (model proposes, code disposes).
export function resolveSpan(
  grid: CutGrid,
  inId: number,
  outId: number
): ResolvedSpan {
  const safeIn = clampId(grid, inId);
  const safeOut = Math.max(safeIn, clampId(grid, outId));
  const clamped = safeIn !== inId || safeOut !== outId;
  return {
    clamped,
    endMs: grid.sentences[safeOut]?.endMs ?? 0,
    startMs: grid.sentences[safeIn]?.startMs ?? 0,
  };
}

export function resolveParagraphSpan(
  grid: CutGrid,
  startPid: number,
  endPid: number
): ResolvedSpan {
  const maxPid = grid.paragraphs.length - 1;
  const safeStart = Math.max(0, Math.min(Math.round(startPid), maxPid));
  const safeEnd = Math.max(safeStart, Math.min(Math.round(endPid), maxPid));
  return {
    clamped: safeStart !== startPid || safeEnd !== endPid,
    endMs: grid.paragraphs[safeEnd]?.endMs ?? 0,
    startMs: grid.paragraphs[safeStart]?.startMs ?? 0,
  };
}

export function sentenceAtMs(grid: CutGrid, ms: number): GridSentence | null {
  let low = 0;
  let high = grid.sentences.length - 1;
  let result: GridSentence | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const sentence = grid.sentences[mid];
    if (!sentence) {
      break;
    }
    if (sentence.startMs <= ms) {
      result = sentence;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result ?? grid.sentences[0] ?? null;
}

// ---- Renderings -----------------------------------------------------------

function stampMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function speakerTag(speaker: string | null): string {
  if (speaker === null) {
    return "S?";
  }
  const numeric = Number(speaker);
  return Number.isInteger(numeric) ? `S${numeric + 1}` : `S${speaker}`;
}

// The coarse ("screening") rendering: one line per paragraph, ID-first,
// compact — what the Director and both rough passes read. mm:ss stays
// visible for pacing but is never the output coordinate.
export function renderCoarse(grid: CutGrid): string {
  return grid.paragraphs
    .map((paragraph) => {
      const text = grid.sentences
        .slice(paragraph.startSentence, paragraph.endSentence + 1)
        .map((sentence) => sentence.text)
        .join(" ");
      return `P${String(paragraph.id).padStart(3, "0")} [${stampMs(paragraph.startMs)}] ${speakerTag(paragraph.speaker)}: ${text}`;
    })
    .join("\n");
}

// The fine ("reel") rendering: one line per sentence with turn/question/
// pause/shot glyphs — what the Cutter reads, built per window on demand.
export function renderFine(
  grid: CutGrid,
  fromSentence: number,
  toSentence: number,
  shotTimesMs: readonly number[] = []
): string {
  const lines: string[] = [];
  for (let id = fromSentence; id <= toSentence; id += 1) {
    const sentence = grid.sentences[id];
    if (!sentence) {
      continue;
    }
    const marks: string[] = [];
    if (sentence.opensTurn) {
      marks.push("⟲turn");
    }
    if (sentence.question) {
      marks.push("·q");
    }
    if (sentence.pauseAfterMs >= DEFAULT_PAUSE_GAP_MS) {
      marks.push(`¶${(sentence.pauseAfterMs / 1000).toFixed(1)}s`);
    }
    if (
      shotTimesMs.some(
        (shot) => Math.abs(shot - sentence.startMs) <= SHOT_SNAP_MS
      )
    ) {
      marks.push("·cut");
    }
    lines.push(
      `s${String(sentence.id).padStart(4, "0")} [${stampMs(sentence.startMs)}] ${speakerTag(sentence.speaker)}: ${sentence.text}${marks.length > 0 ? `  ${marks.join(" ")}` : ""}`
    );
  }
  return lines.join("\n");
}

// ---- Cutter window --------------------------------------------------------

export interface CutterWindow {
  fromSentence: number;
  toSentence: number;
}

function turnStartSentence(grid: CutGrid, id: number): number {
  let cursor = id;
  while (cursor > 0 && !grid.sentences[cursor]?.opensTurn) {
    cursor -= 1;
  }
  return cursor;
}

function turnEndSentence(grid: CutGrid, id: number): number {
  let cursor = id;
  while (
    cursor < grid.sentences.length - 1 &&
    !grid.sentences[cursor]?.endsTurn
  ) {
    cursor += 1;
  }
  return cursor;
}

// The rough span ± margin, expanded to whole turns, then widened to
// include at least CUTTER_PRECEDING_TURNS complete turns before and
// CUTTER_FOLLOWING_TURNS after — the failure shapes M1 measured live in
// exactly that neighborhood.
export function cutterWindow(
  grid: CutGrid,
  range: MsRange,
  marginMs: number = CUTTER_MARGIN_MS
): CutterWindow {
  const first = sentenceAtMs(grid, Math.max(0, range.startMs - marginMs));
  const last = sentenceAtMs(grid, range.endMs + marginMs);
  let from = turnStartSentence(grid, first ? first.id : 0);
  let to = turnEndSentence(grid, last ? last.id : grid.sentences.length - 1);

  const anchor = sentenceAtMs(grid, range.startMs);
  let cursor = turnStartSentence(grid, anchor ? anchor.id : 0);
  for (
    let turns = 0;
    turns < CUTTER_PRECEDING_TURNS && cursor > 0;
    turns += 1
  ) {
    cursor = turnStartSentence(grid, cursor - 1);
  }
  from = Math.min(from, cursor);

  const anchorEnd = sentenceAtMs(
    grid,
    Math.max(range.endMs - 1, range.startMs)
  );
  let endCursor = turnEndSentence(grid, anchorEnd ? anchorEnd.id : 0);
  for (
    let turns = 0;
    turns < CUTTER_FOLLOWING_TURNS && endCursor < grid.sentences.length - 1;
    turns += 1
  ) {
    endCursor = turnEndSentence(grid, endCursor + 1);
  }
  to = Math.max(to, endCursor);

  return { fromSentence: from, toSentence: to };
}

// ---- Deterministic narrative backstops (§5) -------------------------------

export interface BackstopResult {
  flags: string[];
  range: MsRange;
}

// Lead-in capture v2 — up to TWO turns (closes the documented single-turn
// limit of moments.ts's captureLeadIn, the M1 "two-turn setup" gap): a
// span opening on a turn start grows backward over the immediately
// preceding OTHER-speaker turn when it is short and close (the existing
// LEAD_IN_MAX_* caps — a setup, not that speaker's own moment), and then
// over ONE more short fragment turn ("Oh, the standoff?" — either
// speaker) when that too is close. Bounded at two turns, always.
const LEAD_IN_FRAGMENT_MS = 6000;

// One backward step of the lead-in walk: the start sentence of the turn
// preceding `cursor`, or null when that turn does not qualify. The first
// captured turn must be the OTHER speaker's short setup (a same-speaker
// predecessor is mid-monologue — snapping's job; a long turn is that
// speaker's own moment); the second joins only as a short fragment.
function capturableTurnStart(
  grid: CutGrid,
  cursor: number,
  openerSpeaker: string,
  captured: number
): number | null {
  const boundary = grid.sentences[cursor];
  const previous = grid.sentences[cursor - 1];
  if (!(boundary && previous) || previous.speaker === null) {
    return null;
  }
  if (boundary.startMs - previous.endMs > LEAD_IN_MAX_GAP_MS) {
    return null;
  }
  const turnStart = turnStartSentence(grid, previous.id);
  const turnFirst = grid.sentences[turnStart];
  if (!turnFirst) {
    return null;
  }
  const turnLengthMs = previous.endMs - turnFirst.startMs;
  if (captured === 0) {
    if (
      previous.speaker === openerSpeaker ||
      turnLengthMs > LEAD_IN_MAX_TURN_MS
    ) {
      return null;
    }
  } else if (turnLengthMs > LEAD_IN_FRAGMENT_MS) {
    return null;
  }
  return turnStart;
}

export function captureLeadInTwoTurn(
  range: MsRange,
  grid: CutGrid
): BackstopResult {
  const opener = sentenceAtMs(grid, range.startMs);
  if (!opener || opener.startMs < range.startMs || opener.speaker === null) {
    return { flags: [], range };
  }
  // A span opening mid-turn is a mid-monologue start — snapping's job,
  // not lead-in's; walking to the turn start would teleport past the
  // speaker's own build-up.
  if (!opener.opensTurn) {
    return { flags: [], range };
  }
  let cursor = opener.id;
  const capturedStarts: number[] = [];
  let capturedQuestion = false;
  while (capturedStarts.length < 2) {
    const turnStart = capturableTurnStart(
      grid,
      cursor,
      opener.speaker,
      capturedStarts.length
    );
    if (turnStart === null) {
      break;
    }
    // The turn's final sentence is the one adjacent to the previous
    // boundary — question-shape there marks a real setup.
    const turnFinal = grid.sentences[cursor - 1];
    if (turnFinal?.question) {
      capturedQuestion = true;
    }
    cursor = turnStart;
    capturedStarts.push(turnStart);
  }
  // Walking past the immediate setup turn is only safe when a QUESTION was
  // found among the captured turns — otherwise two adjacent short remarks
  // would swallow unrelated material (and, on dense timelines, collapse
  // distinct candidates into dedupe unions). Without one, fall back to the
  // single-turn capture.
  if (capturedStarts.length === 2 && !capturedQuestion) {
    cursor = capturedStarts[0] ?? cursor;
  }
  const first = grid.sentences[cursor];
  if (capturedStarts.length === 0 || !first || first.startMs >= range.startMs) {
    return { flags: [], range };
  }
  return {
    flags: ["lead_in_captured"],
    range: { endMs: range.endMs, startMs: first.startMs },
  };
}

// Lead-out trim (§5 — designed since S6, built here): a span whose FINAL
// sentence opens a different-speaker question turn has run into the next
// exchange; trim back to the previous sentence's end. A clip never ends
// on the next question.
export function leadOutTrim(range: MsRange, grid: CutGrid): BackstopResult {
  const last = sentenceAtMs(grid, Math.max(range.endMs - 1, range.startMs));
  if (!last || last.endMs > range.endMs + 1) {
    return { flags: [], range };
  }
  const previous = grid.sentences[last.id - 1];
  if (!previous || previous.startMs < range.startMs) {
    return { flags: [], range };
  }
  const differentSpeaker =
    last.speaker !== null &&
    previous.speaker !== null &&
    last.speaker !== previous.speaker;
  if (!(differentSpeaker && last.opensTurn && last.question)) {
    return { flags: [], range };
  }
  return {
    flags: ["lead_out_trimmed"],
    range: { endMs: previous.endMs, startMs: range.startMs },
  };
}

// Stale-open detector (§5 — the exact Preity-Zinta shape): a span whose
// FIRST sentence is the final sentence of its speaker's turn opens on the
// tail of the previous answer. Flag, never auto-reject.
export function staleOpenFlag(range: MsRange, grid: CutGrid): boolean {
  const opener = sentenceAtMs(grid, range.startMs);
  if (!opener || Math.abs(opener.startMs - range.startMs) > 1) {
    return false;
  }
  return opener.endsTurn && !opener.opensTurn;
}

// Pause-aware out-point (§5 — "give the payoff its air"): extend the end
// into the silence after the final sentence, up to one pause-gap. Never
// past the next word's start (by construction pauseAfterMs stops there).
export function pauseAirExtend(range: MsRange, grid: CutGrid): MsRange {
  const last = sentenceAtMs(grid, Math.max(range.endMs - 1, range.startMs));
  if (!last || Math.abs(last.endMs - range.endMs) > 1) {
    return range;
  }
  const air = Math.min(last.pauseAfterMs, DEFAULT_PAUSE_GAP_MS);
  if (air <= 0) {
    return range;
  }
  return { endMs: range.endMs + air, startMs: range.startMs };
}

// Shot-snap micro-adjust (§7): move a boundary ONTO a shot change within
// the dead zone, but only over silence — never across a sentence
// boundary, never over speech. In-points snap within the pause BEFORE the
// in sentence; out-points within the pause AFTER the out sentence.
export function shotSnap(
  range: MsRange,
  grid: CutGrid,
  shotTimesMs: readonly number[]
): BackstopResult {
  if (shotTimesMs.length === 0) {
    return { flags: [], range };
  }
  let { endMs, startMs } = range;
  const flags: string[] = [];

  const opener = sentenceAtMs(grid, startMs);
  if (opener && Math.abs(opener.startMs - startMs) <= 1) {
    const previous = grid.sentences[opener.id - 1];
    const silenceFrom = previous ? previous.endMs : 0;
    const shot = shotTimesMs.find(
      (time) =>
        Math.abs(time - startMs) <= SHOT_SNAP_MS &&
        time >= silenceFrom &&
        time <= opener.startMs
    );
    if (shot !== undefined && shot !== startMs) {
      startMs = shot;
      flags.push("shot_snapped");
    }
  }

  const last = sentenceAtMs(grid, Math.max(endMs - 1, startMs));
  if (last) {
    const silenceTo = last.endMs + last.pauseAfterMs;
    const shot = shotTimesMs.find(
      (time) =>
        Math.abs(time - endMs) <= SHOT_SNAP_MS &&
        time >= last.endMs &&
        time <= silenceTo
    );
    if (shot !== undefined && shot !== endMs) {
      endMs = shot;
      if (!flags.includes("shot_snapped")) {
        flags.push("shot_snapped");
      }
    }
  }
  return { flags, range: { endMs, startMs } };
}
