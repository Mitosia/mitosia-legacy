import { describe, expect, it } from "vitest";
import { normalizeAssemblyAiTranscript } from "../lib/transcription/assemblyai";
import { normalizeDeepgramResponse } from "../lib/transcription/deepgram";

// Cross-provider golden test — the point of the seam: the SAME recording,
// as each provider's response shape, must normalize to the SAME canonical
// transcript. Fixtures encode "Hello there. / General Kenobi." with
// identical timings; Deepgram speaks float seconds + numeric speakers,
// AssemblyAI integer milliseconds + letter speakers.

const PROVIDER_ERROR = /download failed/;

const ASSEMBLYAI_FIXTURE = {
  audio_duration: 12.34,
  error: null,
  id: "fixture",
  language_code: "en",
  status: "completed",
  utterances: [
    { confidence: 0.99, end: 1120, speaker: "A", start: 80, text: "…" },
    { confidence: 0.98, end: 3020, speaker: "B", start: 1900, text: "…" },
  ],
  words: [
    {
      confidence: 0.998_853_6,
      end: 640,
      speaker: "A",
      start: 80,
      text: "Hello",
    },
    { confidence: 0.43, end: 1120, speaker: "A", start: 640, text: "there." },
    { confidence: 0.97, end: 2500, speaker: "B", start: 1900, text: "General" },
    { confidence: 0.99, end: 3020, speaker: "B", start: 2500, text: "Kenobi." },
  ],
};

const DEEPGRAM_FIXTURE = {
  metadata: { duration: 12.34 },
  results: {
    channels: [
      {
        alternatives: [
          {
            words: [
              {
                confidence: 0.998_853_6,
                end: 0.64,
                punctuated_word: "Hello",
                speaker: 0,
                start: 0.08,
                word: "hello",
              },
              {
                confidence: 0.43,
                end: 1.12,
                punctuated_word: "there.",
                speaker: 0,
                start: 0.64,
                word: "there",
              },
              {
                confidence: 0.97,
                end: 2.5,
                punctuated_word: "General",
                speaker: 1,
                start: 1.9,
                word: "general",
              },
              {
                confidence: 0.99,
                end: 3.02,
                punctuated_word: "Kenobi.",
                speaker: 1,
                start: 2.5,
                word: "kenobi",
              },
            ],
          },
        ],
        detected_language: "en",
      },
    ],
    utterances: [
      { end: 1.12, speaker: 0, start: 0.08 },
      { end: 3.02, speaker: 1, start: 1.9 },
    ],
  },
};

describe("normalizeAssemblyAiTranscript", () => {
  const data = normalizeAssemblyAiTranscript(ASSEMBLYAI_FIXTURE, 99);

  it("keeps integer milliseconds and maps letter speakers to canonical ids", () => {
    expect(data.words[0]).toEqual({
      confidence: 0.998_853_6,
      endMs: 640,
      speaker: "0",
      startMs: 80,
      text: "Hello",
    });
    expect(data.words.map((word) => word.speaker)).toEqual([
      "0",
      "0",
      "1",
      "1",
    ]);
  });

  it("carries language and provider duration", () => {
    expect(data.language).toBe("en");
    expect(data.durationMs).toBe(12_340);
    expect(data.version).toBe(1);
  });

  it("throws on a provider-reported error instead of returning empties", () => {
    expect(() =>
      normalizeAssemblyAiTranscript(
        { ...ASSEMBLYAI_FIXTURE, error: "download failed", status: "error" },
        99
      )
    ).toThrow(PROVIDER_ERROR);
  });

  it("throws loudly on a shape change", () => {
    expect(() => normalizeAssemblyAiTranscript({ words: [] }, 1)).toThrow();
  });
});

describe("cross-provider equivalence", () => {
  it("both providers normalize the same recording identically", () => {
    const fromAssemblyAi = normalizeAssemblyAiTranscript(
      ASSEMBLYAI_FIXTURE,
      99
    );
    const fromDeepgram = normalizeDeepgramResponse(DEEPGRAM_FIXTURE, 99);
    expect(fromAssemblyAi.words).toEqual(fromDeepgram.words);
    expect(fromAssemblyAi.utterances).toEqual(fromDeepgram.utterances);
    expect(fromAssemblyAi.durationMs).toBe(fromDeepgram.durationMs);
    expect(fromAssemblyAi.language).toBe(fromDeepgram.language);
  });
});
