import type { TranscriptData, TranscriptWord } from "./types";

// Word-level corrections: replace the text of existing words, keeping their
// timings and speakers. Insert/delete/split come with the S8 editing model;
// S3 corrections deliberately stay word-for-word — the dominant real case
// is a misheard word or name.

export interface WordEdit {
  index: number;
  text: string;
}

export class InvalidEditError extends Error {}

export function applyWordEdits(
  data: TranscriptData,
  edits: readonly WordEdit[]
): TranscriptData {
  if (edits.length === 0) {
    throw new InvalidEditError("No edits supplied");
  }
  const words: TranscriptWord[] = [...data.words];
  const seen = new Set<number>();
  for (const edit of edits) {
    const text = edit.text.trim();
    if (text.length === 0) {
      throw new InvalidEditError(`Empty replacement for word ${edit.index}`);
    }
    if (text.length > 200) {
      throw new InvalidEditError(`Replacement too long for word ${edit.index}`);
    }
    if (seen.has(edit.index)) {
      throw new InvalidEditError(`Duplicate edit for word ${edit.index}`);
    }
    seen.add(edit.index);
    const word = words[edit.index];
    if (!word) {
      throw new InvalidEditError(`No word at index ${edit.index}`);
    }
    // A human correction is certain: confidence goes to 1, which also
    // clears the low-confidence marking in the viewer.
    words[edit.index] = { ...word, confidence: 1, text };
  }
  return { ...data, words };
}
