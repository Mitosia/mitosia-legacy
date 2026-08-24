import {
  buildParagraphs,
  type TranscriptParagraph,
} from "@/lib/transcription/paragraphs";
import type { TranscriptData } from "@/lib/transcription/types";

// Deterministic retrieval chunking over the transcript word timeline (S5).
// Builds on buildParagraphs — the same tested speaker-turn segmentation the
// viewer renders — and packs consecutive paragraphs into ~TARGET_TOKENS
// windows. Chunks may span speakers on purpose: rapid exchanges (a question
// and its answer) are exactly what should stay together for retrieval.
//
// Pure and unit-tested; both the index pipeline and any future re-chunk
// tooling must produce identical output for identical input.

// ~300 tokens ≈ 60–90s of speech: small enough that a hit pinpoints a
// moment, large enough to carry context. Token counts are estimated at
// chars/4 — provider-billed tokens are recorded from the API response, this
// estimate only shapes boundaries.
const TARGET_TOKENS = 300;
// A trailing fragment below this merges into the previous chunk — a
// 10-token orphan is noise as a retrieval unit.
const MIN_TAIL_TOKENS = 40;
// A silence this long between paragraphs forces a boundary regardless of
// fill: it almost always marks a topic shift.
const GAP_BREAK_MS = 30_000;

export interface TranscriptChunkDraft {
  endMs: number;
  idx: number;
  // Diarization ids present, in order of first appearance; null speakers
  // are represented in text but not listed here.
  speakers: string[];
  startMs: number;
  text: string;
  tokenCount: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function speakerPrefix(speaker: string | null): string {
  if (speaker === null) {
    return "Speaker";
  }
  const numeric = Number(speaker);
  return Number.isInteger(numeric) ? `Speaker ${numeric + 1}` : speaker;
}

interface ChunkAccumulator {
  endMs: number;
  lastSpeaker: string | null | undefined;
  lines: string[];
  speakers: string[];
  startMs: number;
}

function paragraphLine(
  paragraph: TranscriptParagraph,
  previousSpeaker: string | null | undefined
): string {
  const words = paragraph.words.map((word) => word.text).join(" ");
  // Same-speaker continuation lines skip the marker — markers exist to make
  // dialogue structure visible to both the embedder and the reader.
  return paragraph.speaker === previousSpeaker
    ? words
    : `${speakerPrefix(paragraph.speaker)}: ${words}`;
}

function finishChunk(
  accumulator: ChunkAccumulator,
  idx: number
): TranscriptChunkDraft {
  const text = accumulator.lines.join("\n");
  return {
    endMs: accumulator.endMs,
    idx,
    speakers: accumulator.speakers,
    startMs: accumulator.startMs,
    text,
    tokenCount: estimateTokens(text),
  };
}

export function buildChunks(data: TranscriptData): TranscriptChunkDraft[] {
  const paragraphs = buildParagraphs(data);
  const chunks: TranscriptChunkDraft[] = [];
  let accumulator: ChunkAccumulator | null = null;
  let accumulatedTokens = 0;

  const flush = () => {
    if (accumulator) {
      chunks.push(finishChunk(accumulator, chunks.length));
      accumulator = null;
      accumulatedTokens = 0;
    }
  };

  for (const paragraph of paragraphs) {
    const line = paragraphLine(paragraph, accumulator?.lastSpeaker);
    const lineTokens = estimateTokens(line);

    const gapBreak =
      accumulator !== null &&
      paragraph.startMs - accumulator.endMs > GAP_BREAK_MS;
    const budgetBreak =
      accumulator !== null && accumulatedTokens + lineTokens > TARGET_TOKENS;
    if (gapBreak || budgetBreak) {
      flush();
    }

    if (accumulator === null) {
      accumulator = {
        endMs: paragraph.endMs,
        lastSpeaker: paragraph.speaker,
        // A fresh chunk always opens with a speaker marker
        lines: [paragraphLine(paragraph, undefined)],
        speakers: paragraph.speaker === null ? [] : [paragraph.speaker],
        startMs: paragraph.startMs,
      };
      accumulatedTokens = estimateTokens(accumulator.lines[0] ?? "");
      continue;
    }

    accumulator.lines.push(line);
    accumulator.endMs = paragraph.endMs;
    accumulator.lastSpeaker = paragraph.speaker;
    if (
      paragraph.speaker !== null &&
      !accumulator.speakers.includes(paragraph.speaker)
    ) {
      accumulator.speakers.push(paragraph.speaker);
    }
    accumulatedTokens += lineTokens;
  }
  flush();

  // Merge an undersized tail into its predecessor so the last retrieval
  // unit is as meaningful as the rest.
  const tail = chunks.at(-1);
  const previous = chunks.at(-2);
  if (tail && previous && tail.tokenCount < MIN_TAIL_TOKENS) {
    chunks.pop();
    chunks.pop();
    const mergedText = `${previous.text}\n${tail.text}`;
    chunks.push({
      endMs: tail.endMs,
      idx: chunks.length,
      speakers: [
        ...previous.speakers,
        ...tail.speakers.filter((s) => !previous.speakers.includes(s)),
      ],
      startMs: previous.startMs,
      text: mergedText,
      tokenCount: estimateTokens(mergedText),
    });
  }

  return chunks;
}
