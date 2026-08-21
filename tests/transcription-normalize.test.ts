import { describe, expect, it } from "vitest";
import { normalizeDeepgramResponse } from "../lib/transcription/deepgram";
import { createMockProvider } from "../lib/transcription/mock";

// Golden tests for provider normalization: fixture responses (shaped from
// real API output) go through the exact mapping production uses. When the
// AssemblyAI adapter lands, its fixture must normalize to this same
// canonical shape — that cross-provider equivalence is the point of the
// seam.

// Trimmed but structurally faithful Deepgram prerecorded response with
// diarize + smart_format + utterances + detect_language.
const DEEPGRAM_FIXTURE = {
  metadata: {
    channels: 1,
    created: "2026-08-22T00:00:00.000Z",
    duration: 12.34,
    models: ["general-nova-3"],
  },
  results: {
    channels: [
      {
        alternatives: [
          {
            confidence: 0.998,
            transcript: "Hello there. General Kenobi.",
            words: [
              {
                confidence: 0.998_853_6,
                end: 0.64,
                punctuated_word: "Hello",
                speaker: 0,
                speaker_confidence: 0.92,
                start: 0.08,
                word: "hello",
              },
              {
                confidence: 0.43,
                end: 1.12,
                punctuated_word: "there.",
                speaker: 0,
                speaker_confidence: 0.92,
                start: 0.64,
                word: "there",
              },
              {
                confidence: 0.97,
                end: 2.5,
                punctuated_word: "General",
                speaker: 1,
                speaker_confidence: 0.88,
                start: 1.9,
                word: "general",
              },
              {
                confidence: 0.99,
                end: 3.02,
                punctuated_word: "Kenobi.",
                speaker: 1,
                speaker_confidence: 0.88,
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
      { channel: 0, end: 1.12, speaker: 0, start: 0.08, transcript: "…" },
      { channel: 0, end: 3.02, speaker: 1, start: 1.9, transcript: "…" },
    ],
  },
};

describe("normalizeDeepgramResponse", () => {
  const data = normalizeDeepgramResponse(DEEPGRAM_FIXTURE, 99);

  it("maps words to integer milliseconds with punctuated text", () => {
    expect(data.words).toHaveLength(4);
    const [first] = data.words;
    expect(first).toEqual({
      confidence: 0.998_853_6,
      endMs: 640,
      speaker: "0",
      startMs: 80,
      text: "Hello",
    });
    for (const word of data.words) {
      expect(Number.isInteger(word.startMs)).toBe(true);
      expect(Number.isInteger(word.endMs)).toBe(true);
    }
  });

  it("keeps diarization speakers as strings", () => {
    expect(data.words.map((word) => word.speaker)).toEqual([
      "0",
      "0",
      "1",
      "1",
    ]);
    expect(data.utterances.map((utterance) => utterance.speaker)).toEqual([
      "0",
      "1",
    ]);
  });

  it("prefers provider duration and detected language", () => {
    expect(data.durationMs).toBe(12_340);
    expect(data.language).toBe("en");
    expect(data.version).toBe(1);
  });

  it("preserves low confidence values for the viewer", () => {
    expect(data.words[1]?.confidence).toBe(0.43);
  });

  it("falls back to probe duration when metadata omits one", () => {
    const noDuration = structuredClone(DEEPGRAM_FIXTURE) as {
      metadata?: unknown;
    };
    noDuration.metadata = {};
    const fallback = normalizeDeepgramResponse(noDuration, 42.5);
    expect(fallback.durationMs).toBe(42_500);
  });

  it("throws loudly on a shape change instead of dropping fields", () => {
    expect(() => normalizeDeepgramResponse({ results: {} }, 1)).toThrow();
  });
});

describe("mock provider", () => {
  it("is deterministic and spans the media duration", async () => {
    const provider = createMockProvider();
    const request = {
      audioUrl: "https://example.invalid/audio.m4a",
      durationSeconds: 120,
      mimeType: "audio/mp4",
    };
    const a = await provider.transcribe(request);
    const b = await provider.transcribe(request);
    expect(a).toEqual(b);

    expect(a.data.words.length).toBeGreaterThan(10);
    const last = a.data.words.at(-1);
    // Words cover the full duration (within one slot) so duration sanity
    // checks see realistic coverage
    expect(last?.endMs).toBeGreaterThan(120_000 * 0.9);
    expect(last?.endMs).toBeLessThanOrEqual(120_000);

    // Both speakers present, and low-confidence words exist for the UI
    const speakers = new Set(a.data.words.map((word) => word.speaker));
    expect(speakers).toEqual(new Set(["0", "1"]));
    expect(a.data.words.some((word) => (word.confidence ?? 1) < 0.6)).toBe(
      true
    );
  });
});
