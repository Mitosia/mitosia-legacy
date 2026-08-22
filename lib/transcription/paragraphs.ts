import type { TranscriptData, TranscriptWord } from "./types";

// Pure view-model helpers for the transcript panel. Client-safe (types
// only), unit-tested — the viewer's correctness lives here, the component
// only renders.

// A new paragraph starts on a speaker change, a long silence, or when the
// current one grows past a size cap (a single speaker monologuing for ten
// minutes must not become one giant row — virtualization works on
// paragraphs).
const PARAGRAPH_GAP_MS = 2500;
const PARAGRAPH_MAX_WORDS = 120;

export interface TranscriptParagraph {
  endMs: number;
  speaker: string | null;
  startMs: number;
  // Index of words[0] within the flat transcript word array — the bridge
  // between paragraph-local and transcript-global word indices.
  wordOffset: number;
  words: TranscriptWord[];
}

function startsNewParagraph(
  current: TranscriptParagraph | null,
  word: TranscriptWord
): boolean {
  if (!current) {
    return true;
  }
  const previous = current.words.at(-1);
  if (!previous) {
    return true;
  }
  return (
    word.speaker !== current.speaker ||
    word.startMs - previous.endMs > PARAGRAPH_GAP_MS ||
    current.words.length >= PARAGRAPH_MAX_WORDS
  );
}

export function buildParagraphs(data: TranscriptData): TranscriptParagraph[] {
  const paragraphs: TranscriptParagraph[] = [];
  let current: TranscriptParagraph | null = null;

  for (const [index, word] of data.words.entries()) {
    if (startsNewParagraph(current, word)) {
      current = {
        endMs: word.endMs,
        speaker: word.speaker,
        startMs: word.startMs,
        wordOffset: index,
        words: [word],
      };
      paragraphs.push(current);
    } else if (current) {
      current.words.push(word);
      current.endMs = word.endMs;
    }
  }

  return paragraphs;
}

// Last word whose startMs <= timeMs (binary search over the flat word
// array; words are start-ordered by construction). -1 before the first
// word. This deliberately keeps a word "active" through trailing silence
// until the next word starts — a blinking highlight during gaps reads as
// flicker, not precision.
export function findWordIndexAtTime(
  words: readonly TranscriptWord[],
  timeMs: number
): number {
  let low = 0;
  let high = words.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const word = words[mid];
    if (!word) {
      break;
    }
    if (word.startMs <= timeMs) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

// Paragraph containing a global word index (binary search over wordOffset).
export function findParagraphIndexForWord(
  paragraphs: readonly TranscriptParagraph[],
  wordIndex: number
): number {
  if (wordIndex < 0) {
    return -1;
  }
  let low = 0;
  let high = paragraphs.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const paragraph = paragraphs[mid];
    if (!paragraph) {
      break;
    }
    if (paragraph.wordOffset <= wordIndex) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

export function speakerDisplayName(
  speaker: string | null,
  speakerLabels: Record<string, string> | null
): string {
  if (speaker === null) {
    return "Speaker";
  }
  const custom = speakerLabels?.[speaker];
  if (custom) {
    return custom;
  }
  const numeric = Number(speaker);
  return Number.isInteger(numeric) ? `Speaker ${numeric + 1}` : speaker;
}
