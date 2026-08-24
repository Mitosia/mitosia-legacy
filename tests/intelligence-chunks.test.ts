import { describe, expect, it } from "vitest";
import { buildChunks } from "../lib/intelligence/chunks";
import type {
  TranscriptData,
  TranscriptWord,
} from "../lib/transcription/types";

// The chunker feeds both the embedding index and (via startMs/endMs) every
// citation the UI plays — boundary correctness is the whole game.

function makeWords(
  sentences: { gapMs?: number; speaker: string | null; words: string[] }[]
): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let cursor = 0;
  for (const sentence of sentences) {
    cursor += sentence.gapMs ?? 200;
    for (const text of sentence.words) {
      out.push({
        confidence: 0.95,
        endMs: cursor + 250,
        speaker: sentence.speaker,
        startMs: cursor,
        text,
      });
      cursor += 300;
    }
  }
  return out;
}

function makeData(words: TranscriptWord[]): TranscriptData {
  return {
    durationMs: (words.at(-1)?.endMs ?? 0) + 500,
    language: "en",
    utterances: [],
    version: 1,
    words,
  };
}

const LOREM =
  "the quick brown fox jumps over the lazy dog while narrating a story about media pipelines".split(
    " "
  );

describe("buildChunks", () => {
  it("produces sequential, non-overlapping, word-aligned chunks", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => ({
      speaker: String(i % 2),
      words: LOREM,
    }));
    const data = makeData(makeWords(sentences));
    const chunks = buildChunks(data);

    expect(chunks.length).toBeGreaterThan(1);
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.idx).toBe(i);
      expect(chunk.endMs).toBeGreaterThan(chunk.startMs);
      if (i > 0) {
        // biome-ignore lint/style/noNonNullAssertion: i > 0
        expect(chunk.startMs).toBeGreaterThanOrEqual(chunks[i - 1]!.endMs);
      }
    }
    // Coverage: first chunk starts at the first word, last ends at the last
    expect(chunks[0]?.startMs).toBe(data.words[0]?.startMs);
    expect(chunks.at(-1)?.endMs).toBe(data.words.at(-1)?.endMs);
  });

  it("keeps chunks near the token target", () => {
    const sentences = Array.from({ length: 60 }, (_, i) => ({
      speaker: String(i % 3),
      words: LOREM,
    }));
    const chunks = buildChunks(makeData(makeWords(sentences)));
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThan(450);
    }
    // All but the tail should be meaningfully filled
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.tokenCount).toBeGreaterThan(100);
    }
  });

  it("opens every chunk with a speaker marker and tracks speakers", () => {
    const chunks = buildChunks(
      makeData(
        makeWords([
          { speaker: "0", words: ["Hello", "there", "friend"] },
          { speaker: "1", words: ["Hi", "back", "at", "you"] },
        ])
      )
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(
      "Speaker 1: Hello there friend\nSpeaker 2: Hi back at you"
    );
    expect(chunks[0]?.speakers).toEqual(["0", "1"]);
  });

  it("breaks on long silences even under the token target", () => {
    const chunks = buildChunks(
      makeData(
        makeWords([
          { speaker: "0", words: ["before", "the", "long", "pause"] },
          { gapMs: 45_000, speaker: "0", words: LOREM.concat(LOREM) },
        ])
      )
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const gap = chunks[1]!.startMs - chunks[0]!.endMs;
    expect(gap).toBeGreaterThan(30_000);
  });

  it("merges an undersized tail into the previous chunk", () => {
    const sentences = [
      ...Array.from({ length: 20 }, () => ({
        speaker: "0",
        words: LOREM,
      })),
      { speaker: "1", words: ["tiny", "tail"] },
    ];
    const chunks = buildChunks(makeData(makeWords(sentences)));
    const tail = chunks.at(-1);
    expect(tail?.text).toContain("tiny tail");
    expect(tail?.tokenCount).toBeGreaterThan(40);
    expect(tail?.speakers).toContain("1");
    // Sequential idx survives the merge
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.idx).toBe(i);
    }
  });

  it("is deterministic", () => {
    const sentences = Array.from({ length: 25 }, (_, i) => ({
      speaker: String(i % 2),
      words: LOREM,
    }));
    const data = makeData(makeWords(sentences));
    expect(buildChunks(data)).toEqual(buildChunks(data));
  });

  it("handles an empty transcript", () => {
    expect(buildChunks(makeData([]))).toEqual([]);
  });
});
