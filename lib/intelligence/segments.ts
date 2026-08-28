import type { RawSegmentItem } from "@/lib/ai/capabilities/segment-plan";
import type {
  SegmentDropReason,
  SegmentKind,
} from "@/lib/db/schema/intelligence";
import type { TranscriptWord } from "@/lib/transcription/types";
import { alignExtraction, tokenizeWords } from "./grounding";
import {
  type DedupeChunk,
  type MsRange,
  pauseBoundaries,
  SNAP_MAX_GROWTH_MS,
  semanticTwinPairs,
  sentenceStarts,
} from "./moments";

// Deterministic gates for the segment plan (S6.5): the model proposes a
// keep/drop partition; this file REBUILDS it as a true tiling of the word
// timeline, so the coverage invariant holds by construction — every second
// of the recording belongs to exactly one segment.
//
// Mechanism: each proposed segment start becomes a CUT POINT, snapped to
// the sentence grid (pause fallback, nearest-word last resort — a cut
// always resolves). Cut points partition the words into slots; each slot's
// startMs is its first word's start and its endMs is its last word's end,
// so adjacent segments share boundaries modulo inter-word silence. The
// model's proposals map onto slots in order; leading uncovered words
// become a synthesized drop; collapsed cuts and zero-time spans merge
// neighbors with a flag — no row is ever zero-length.
//
// Constraint policy (2026-08-26): NO numeric editorial enforcement.
// Duration/count outliers are detected RELATIVELY (against the plan's own
// median) and surface as flags for the human reviewer — never as
// auto-demotion, auto-splitting, or rejection.

export const SHORT_OUTLIER_RATIO = 0.25;
export const LONG_OUTLIER_RATIO = 4;
// Below this many keeps, "outlier vs the plan's median" is meaningless.
const MIN_KEEPS_FOR_OUTLIERS = 3;

export interface SegmentRow {
  anchorText: string | null;
  dropReason: SegmentDropReason | null;
  endMs: number;
  flags: string[];
  grounded: boolean;
  groundingScore: number;
  hook: string | null;
  idx: number;
  kind: SegmentKind;
  rawEndMs: number;
  rawStartMs: number;
  startMs: number;
  summary: string | null;
  title: string | null;
}

// Nearest word index whose startMs can serve as this cut: a sentence
// start within the growth cap, else a pause boundary within the cap, else
// the nearest word start outright — a cut point always lands on a word.
export function snapCutIndex(
  words: readonly TranscriptWord[],
  atMs: number
): number {
  const nearest = (indices: readonly number[], cap: number): number | null => {
    let best: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const index of indices) {
      const distance = Math.abs((words[index]?.startMs ?? 0) - atMs);
      if (distance < bestDistance && distance <= cap) {
        best = index;
        bestDistance = distance;
      }
    }
    return best;
  };
  const sentence = nearest(sentenceStarts(words), SNAP_MAX_GROWTH_MS);
  if (sentence !== null) {
    return sentence;
  }
  const pause = nearest(pauseBoundaries(words), SNAP_MAX_GROWTH_MS);
  if (pause !== null) {
    return pause;
  }
  return (
    nearest(
      words.map((_, index) => index),
      Number.POSITIVE_INFINITY
    ) ?? 0
  );
}

interface Slot {
  endWord: number;
  item: RawSegmentItem | null;
  merged: boolean;
  startWord: number;
}

// A collapsed proposal joins an existing slot: flagged for the reviewer,
// keeping the more content-bearing identity.
function absorbItem(slot: Slot, item: RawSegmentItem): void {
  slot.merged = true;
  if (slot.item?.kind !== "keep" && item.kind === "keep") {
    slot.item = item;
  }
}

// Partition the word range into slots from the proposed items' snapped
// starts. Items map to slots in order; a collapsed cut (two proposals
// snapping to one point) merges neighbors, preferring the keep's identity.
// A slot whose words span zero time merges the same way: Deepgram rounds
// sub-centisecond words to equal start/end ms, so a proposal cutting
// exactly at the final word's end would otherwise stand as a zero-length
// row with nothing a reviewer can play. Merging (never filtering) is what
// keeps the tiling invariant — the plan must still start at the first
// word's start and end at the last word's end.
function buildSlots(
  items: readonly RawSegmentItem[],
  words: readonly TranscriptWord[]
): Slot[] {
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
  const [head] = sorted;
  if (!head) {
    return [];
  }
  const spanMs = (startWord: number, endWord: number): number =>
    (words[endWord]?.endMs ?? 0) - (words[startWord]?.startMs ?? 0);

  const slots: Slot[] = [];
  const leadIndex = snapCutIndex(words, head.startMs);
  // Words before the first proposal: a synthesized drop, never silence —
  // unless they span zero time, in which case they fold into the first
  // proposal's slot instead of standing as an unplayable gap row.
  const leadIsAudible = leadIndex > 0 && spanMs(0, leadIndex - 1) > 0;
  if (leadIsAudible) {
    slots.push({
      endWord: leadIndex - 1,
      item: null,
      merged: false,
      startWord: 0,
    });
  }

  let cursor = leadIsAudible ? leadIndex : 0;
  for (const [position, item] of sorted.entries()) {
    const nextItem = sorted[position + 1];
    const nextCut = nextItem
      ? snapCutIndex(words, nextItem.startMs)
      : words.length;
    const current = slots.at(-1);
    if (nextCut <= cursor) {
      // The next proposal's cut collapsed into this slot: merge.
      if (current) {
        absorbItem(current, item);
      }
      continue;
    }
    if (spanMs(cursor, nextCut - 1) <= 0) {
      // Zero-length slot: its words are inaudible, so the previous slot
      // absorbs both them and the proposal's identity. With no previous
      // slot the words fold forward into the next one instead (cursor
      // stays) and the vacuous proposal is discarded.
      if (current) {
        absorbItem(current, item);
        current.endWord = nextCut - 1;
        cursor = nextCut;
      }
      continue;
    }
    slots.push({
      endWord: nextCut - 1,
      item,
      merged: false,
      startWord: cursor,
    });
    cursor = nextCut;
  }
  return slots.filter((slot) => slot.endWord >= slot.startWord);
}

function clampRaw(item: RawSegmentItem | null, durationMs: number) {
  const rawStartMs = Math.max(0, Math.min(item?.startMs ?? 0, durationMs));
  return {
    rawEndMs: Math.max(rawStartMs, Math.min(item?.endMs ?? 0, durationMs)),
    rawStartMs,
  };
}

function applyOutlierFlags(rows: SegmentRow[]): void {
  const keeps = rows.filter((row) => row.kind === "keep");
  if (keeps.length < MIN_KEEPS_FOR_OUTLIERS) {
    return;
  }
  const durations = keeps
    .map((row) => row.endMs - row.startMs)
    .sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)] ?? 0;
  if (median <= 0) {
    return;
  }
  for (const row of keeps) {
    const duration = row.endMs - row.startMs;
    if (duration < median * SHORT_OUTLIER_RATIO) {
      row.flags.push("short_outlier");
    } else if (duration > median * LONG_OUTLIER_RATIO) {
      row.flags.push("long_outlier");
    }
  }
}

function applyTwiceToldFlags(
  rows: SegmentRow[],
  chunks: readonly DedupeChunk[]
): void {
  const keeps = rows
    .map((row, index) => ({ index, row }))
    .filter(({ row }) => row.kind === "keep");
  const ranges: MsRange[] = keeps.map(({ row }) => ({
    endMs: row.endMs,
    startMs: row.startMs,
  }));
  for (const [a, b] of semanticTwinPairs(ranges, chunks)) {
    for (const position of [a, b]) {
      const target = keeps[position];
      if (target && !target.row.flags.includes("twice_told")) {
        target.row.flags.push("twice_told");
      }
    }
  }
}

function slotGrounding(
  item: RawSegmentItem | null,
  startMs: number,
  endMs: number,
  tokens: ReturnType<typeof tokenizeWords>,
  flags: string[]
): { grounded: boolean; groundingScore: number } {
  if (item?.kind !== "keep") {
    return { grounded: true, groundingScore: 1 };
  }
  if (!item.anchorText) {
    flags.push("no_anchor");
    return { grounded: false, groundingScore: 0 };
  }
  const aligned = alignExtraction(item.anchorText, startMs, endMs, tokens);
  return {
    grounded:
      aligned.grounded && aligned.startMs >= startMs && aligned.endMs <= endMs,
    groundingScore: aligned.score,
  };
}

function slotToRow(
  slot: Slot,
  words: readonly TranscriptWord[],
  durationMs: number,
  tokens: ReturnType<typeof tokenizeWords>
): SegmentRow {
  const startMs = words[slot.startWord]?.startMs ?? 0;
  const endMs = words[slot.endWord]?.endMs ?? durationMs;
  const { item } = slot;
  const flags: string[] = [];
  if (!item) {
    flags.push("gap_fill");
  }
  if (slot.merged) {
    flags.push("merged_neighbor");
  }

  const { rawEndMs, rawStartMs } = clampRaw(item, durationMs);
  const isKeep = item?.kind === "keep";
  const { grounded, groundingScore } = slotGrounding(
    item,
    startMs,
    endMs,
    tokens,
    flags
  );

  return {
    anchorText: isKeep ? (item?.anchorText ?? null) : null,
    dropReason: isKeep
      ? null
      : (item?.dropReason ?? ("other" as SegmentDropReason)),
    endMs,
    flags,
    grounded,
    groundingScore,
    hook: isKeep ? (item?.hook ?? null) : null,
    idx: 0,
    kind: isKeep ? "keep" : "drop",
    rawEndMs,
    rawStartMs,
    startMs,
    summary: isKeep ? (item?.summary ?? null) : null,
    title: isKeep ? (item?.title ?? null) : null,
  };
}

// The full gauntlet: slots from snapped cuts → per-slot rows (kept
// identity, synthesized drops for uncovered stretches) → anchor grounding
// on keeps → relative-outlier + twice-told observability flags →
// chronological idx. Pure and deterministic.
export function buildSegmentRows(
  items: readonly RawSegmentItem[],
  words: readonly TranscriptWord[],
  durationMs: number,
  chunks: readonly DedupeChunk[]
): SegmentRow[] {
  if (words.length === 0 || items.length === 0) {
    return [];
  }
  const tokens = tokenizeWords(words);
  const slots = buildSlots(items, words);
  const rows: SegmentRow[] = slots.map((slot) =>
    slotToRow(slot, words, durationMs, tokens)
  );

  applyOutlierFlags(rows);
  applyTwiceToldFlags(rows, chunks);
  for (const [index, row] of rows.entries()) {
    row.idx = index;
  }
  return rows;
}

export interface PartitionCheck {
  issues: string[];
  ok: boolean;
}

// The coverage invariant, checkable anywhere (tests, eval, e2e): rows are
// chronological, non-overlapping, span the whole word timeline, and every
// gap between adjacent rows is inter-word silence only (the next row
// starts at the very next word).
export function checkPartition(
  rows: readonly SegmentRow[],
  words: readonly TranscriptWord[]
): PartitionCheck {
  const issues: string[] = [];
  const [first] = words;
  const last = words.at(-1);
  if (!(first && last) || rows.length === 0) {
    return { issues: ["empty plan or timeline"], ok: false };
  }
  if (rows[0]?.startMs !== first.startMs) {
    issues.push("plan does not start at the first word");
  }
  if (rows.at(-1)?.endMs !== last.endMs) {
    issues.push("plan does not end at the last word");
  }
  const wordStarts = new Set(words.map((word) => word.startMs));
  for (const [index, row] of rows.entries()) {
    if (row.endMs <= row.startMs) {
      issues.push(`segment ${index} has an empty range`);
    }
    const next = rows[index + 1];
    if (!next) {
      continue;
    }
    if (next.startMs <= row.startMs) {
      issues.push(`segments ${index} and ${index + 1} are out of order`);
    }
    if (next.startMs < row.endMs) {
      issues.push(`segments ${index} and ${index + 1} overlap`);
    }
    if (!wordStarts.has(next.startMs)) {
      issues.push(`segment ${index + 1} starts off the word timeline`);
    }
  }
  return { issues, ok: issues.length === 0 };
}
