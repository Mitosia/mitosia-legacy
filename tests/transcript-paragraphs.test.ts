import { describe, expect, it } from "vitest";
import {
  buildParagraphs,
  findParagraphIndexForWord,
  findWordIndexAtTime,
  speakerDisplayName,
} from "../lib/transcription/paragraphs";
import type {
  TranscriptData,
  TranscriptWord,
} from "../lib/transcription/types";

function word(
  startMs: number,
  endMs: number,
  speaker: string | null,
  text = "w"
): TranscriptWord {
  return { confidence: 0.9, endMs, speaker, startMs, text };
}

function data(words: TranscriptWord[]): TranscriptData {
  return {
    durationMs: words.at(-1)?.endMs ?? 0,
    language: "en",
    utterances: [],
    version: 1,
    words,
  };
}

describe("buildParagraphs", () => {
  it("splits on speaker change", () => {
    const paragraphs = buildParagraphs(
      data([
        word(0, 400, "0"),
        word(400, 800, "0"),
        word(900, 1300, "1"),
        word(1300, 1700, "1"),
      ])
    );
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.speaker).toBe("0");
    expect(paragraphs[1]?.speaker).toBe("1");
    expect(paragraphs[1]?.wordOffset).toBe(2);
  });

  it("splits on long silence within one speaker", () => {
    const paragraphs = buildParagraphs(
      data([word(0, 400, "0"), word(400, 800, "0"), word(5000, 5400, "0")])
    );
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1]?.startMs).toBe(5000);
  });

  it("caps paragraph size for monologues", () => {
    const words: TranscriptWord[] = [];
    for (let i = 0; i < 300; i += 1) {
      words.push(word(i * 100, i * 100 + 80, "0"));
    }
    const paragraphs = buildParagraphs(data(words));
    expect(paragraphs.length).toBeGreaterThan(1);
    for (const paragraph of paragraphs) {
      expect(paragraph.words.length).toBeLessThanOrEqual(120);
    }
    // Offsets tile the word array exactly
    const total = paragraphs.reduce(
      (count, paragraph) => count + paragraph.words.length,
      0
    );
    expect(total).toBe(300);
    // The cap is 120, so the first paragraph is exactly 120 words and the
    // second starts right after it.
    expect(paragraphs[1]?.wordOffset).toBe(120);
  });

  it("handles an empty transcript", () => {
    expect(buildParagraphs(data([]))).toEqual([]);
  });
});

describe("findWordIndexAtTime", () => {
  const words = [word(0, 400, "0"), word(500, 900, "0"), word(1000, 1400, "0")];

  it("returns -1 before the first word", () => {
    expect(findWordIndexAtTime(words, -50)).toBe(-1);
  });

  it("finds the word containing the time", () => {
    expect(findWordIndexAtTime(words, 600)).toBe(1);
  });

  it("stays on the previous word through a gap", () => {
    expect(findWordIndexAtTime(words, 950)).toBe(1);
  });

  it("clamps to the last word past the end", () => {
    expect(findWordIndexAtTime(words, 99_999)).toBe(2);
  });
});

describe("findParagraphIndexForWord", () => {
  const paragraphs = buildParagraphs(
    data([
      word(0, 400, "0"),
      word(400, 800, "0"),
      word(900, 1300, "1"),
      word(1300, 1700, "1"),
    ])
  );

  it("maps global word indices to their paragraph", () => {
    expect(findParagraphIndexForWord(paragraphs, 0)).toBe(0);
    expect(findParagraphIndexForWord(paragraphs, 1)).toBe(0);
    expect(findParagraphIndexForWord(paragraphs, 2)).toBe(1);
    expect(findParagraphIndexForWord(paragraphs, 3)).toBe(1);
  });

  it("returns -1 for no active word", () => {
    expect(findParagraphIndexForWord(paragraphs, -1)).toBe(-1);
  });
});

describe("speakerDisplayName", () => {
  it("prefers custom labels, falls back to 1-based numbering", () => {
    expect(speakerDisplayName("0", { "0": "Priya" })).toBe("Priya");
    expect(speakerDisplayName("1", { "0": "Priya" })).toBe("Speaker 2");
    expect(speakerDisplayName(null, null)).toBe("Speaker");
    expect(speakerDisplayName("host", null)).toBe("host");
  });
});
