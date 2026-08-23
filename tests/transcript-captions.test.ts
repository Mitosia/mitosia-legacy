import { describe, expect, it } from "vitest";
import { buildCues, cuesToSrt, cuesToVtt } from "../lib/transcription/captions";
import { applyWordEdits, InvalidEditError } from "../lib/transcription/edits";
import type {
  TranscriptData,
  TranscriptWord,
} from "../lib/transcription/types";

function word(
  startMs: number,
  endMs: number,
  speaker: string,
  text: string
): TranscriptWord {
  return { confidence: 0.95, endMs, speaker, startMs, text };
}

describe("buildCues", () => {
  it("breaks on speaker change even mid-sentence", () => {
    const cues = buildCues([
      word(0, 400, "0", "So"),
      word(400, 800, "0", "what"),
      word(900, 1300, "1", "wait"),
    ]);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ speaker: "0", text: "So what" });
    expect(cues[1]).toMatchObject({ speaker: "1", text: "wait" });
  });

  it("breaks after sentence-ending punctuation", () => {
    const cues = buildCues([
      word(0, 400, "0", "Done."),
      word(500, 900, "0", "Next"),
    ]);
    expect(cues.map((cue) => cue.text)).toEqual(["Done.", "Next"]);
  });

  it("breaks on long silence", () => {
    const cues = buildCues([
      word(0, 400, "0", "before"),
      word(2000, 2400, "0", "after"),
    ]);
    expect(cues).toHaveLength(2);
  });

  it("caps cue length in characters", () => {
    const words: TranscriptWord[] = [];
    for (let i = 0; i < 40; i += 1) {
      words.push(word(i * 300, i * 300 + 250, "0", "lorem"));
    }
    const cues = buildCues(words);
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(70);
    }
  });

  it("caps cue duration", () => {
    // Slow speech, no punctuation: one word every 2.4s never trips the char
    // cap but must trip the 7s duration cap.
    const words: TranscriptWord[] = [];
    for (let i = 0; i < 8; i += 1) {
      words.push(word(i * 2400, i * 2400 + 2300, "0", "hm"));
    }
    const cues = buildCues(words);
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(7000 + 2300);
    }
  });
});

describe("serialization", () => {
  const cues = buildCues([
    word(80, 400, "0", "Hello"),
    word(400, 1120, "0", "there."),
    word(1900, 2500, "1", "General"),
    word(2500, 3020, "1", "Kenobi."),
  ]);
  const labels = { "0": "Obi-Wan" };

  it("SRT prefixes speaker names on change only", () => {
    const srt = cuesToSrt(cues, labels);
    expect(srt).toContain("[Obi-Wan] Hello there.");
    expect(srt).toContain("[Speaker 2] General Kenobi.");
    expect(srt).toContain("00:00:00,080 --> 00:00:01,120");
  });

  it("VTT uses voice tags and dot timestamps", () => {
    const vtt = cuesToVtt(cues, labels);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.080 --> 00:00:01.120");
    expect(vtt).toContain("<v Obi-Wan>Hello there.");
    expect(vtt).toContain("<v Speaker 2>General Kenobi.");
  });
});

describe("applyWordEdits", () => {
  const data: TranscriptData = {
    durationMs: 3020,
    language: "en",
    utterances: [],
    version: 1,
    words: [
      word(80, 400, "0", "Hello"),
      { ...word(400, 1120, "0", "their."), confidence: 0.4 },
    ],
  };

  it("replaces text, keeps timing, and marks the word certain", () => {
    const next = applyWordEdits(data, [{ index: 1, text: "there." }]);
    expect(next.words[1]).toEqual({
      confidence: 1,
      endMs: 1120,
      speaker: "0",
      startMs: 400,
      text: "there.",
    });
    // Immutable: the original is untouched
    expect(data.words[1]?.text).toBe("their.");
  });

  it("rejects out-of-range, empty, and duplicate edits", () => {
    expect(() => applyWordEdits(data, [{ index: 9, text: "x" }])).toThrow(
      InvalidEditError
    );
    expect(() => applyWordEdits(data, [{ index: 0, text: "  " }])).toThrow(
      InvalidEditError
    );
    expect(() =>
      applyWordEdits(data, [
        { index: 0, text: "a" },
        { index: 0, text: "b" },
      ])
    ).toThrow(InvalidEditError);
    expect(() => applyWordEdits(data, [])).toThrow(InvalidEditError);
  });
});
