import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeChapters,
  runSourceAnalysis,
  transcriptToPromptText,
} from "../lib/ai/capabilities/source-analysis";
import {
  canonicalJson,
  hashContextPack,
  type SourceContextPack,
} from "../lib/ai/context";
import type { TranscriptData } from "../lib/transcription/types";

const transcript: TranscriptData = {
  durationMs: 6000,
  language: "en",
  utterances: [],
  version: 1,
  words: [
    { confidence: 0.9, endMs: 900, speaker: "0", startMs: 0, text: "Hello" },
    {
      confidence: 0.9,
      endMs: 1900,
      speaker: "0",
      startMs: 1000,
      text: "there.",
    },
    {
      confidence: 0.9,
      endMs: 4400,
      speaker: "1",
      startMs: 3500,
      text: "General",
    },
    {
      confidence: 0.9,
      endMs: 5900,
      speaker: "1",
      startMs: 4500,
      text: "Kenobi.",
    },
  ],
};

const pack: SourceContextPack = {
  brand: { name: "Acme" },
  client: { name: "Acme Co" },
  kind: "source-analysis",
  organization: { name: "RP Studio" },
  project: { name: "Podcast" },
  source: {
    durationSeconds: 6,
    language: "en",
    originalFilename: "clip.mp4",
    speakerCount: 2,
    title: "Test clip",
  },
  version: 1,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("transcriptToPromptText", () => {
  it("renders speaker turns with timestamps and raw ids", () => {
    const text = transcriptToPromptText(transcript);
    expect(text).toContain("[00:00] Speaker 1 (id=0): Hello there.");
    expect(text).toContain("[00:03] Speaker 2 (id=1): General Kenobi.");
  });
});

describe("normalizeChapters", () => {
  it("sorts, clamps to duration, and removes overlaps", () => {
    const repaired = normalizeChapters(
      [
        { endMs: 9000, startMs: 4000, summary: "b", title: "B" },
        { endMs: 5000, startMs: 0, summary: "a", title: "A" },
      ],
      6000
    );
    expect(repaired).toEqual([
      { endMs: 5000, startMs: 0, summary: "a", title: "A" },
      { endMs: 6000, startMs: 5000, summary: "b", title: "B" },
    ]);
  });

  it("drops subsumed and out-of-range chapters", () => {
    const repaired = normalizeChapters(
      [
        { endMs: 6000, startMs: 0, summary: "a", title: "A" },
        // Fully inside A after clamping — collapses to zero length
        { endMs: 6000, startMs: 5999, summary: "late", title: "Late" },
        // Entirely past the media end
        { endMs: 9000, startMs: 8000, summary: "off", title: "Off the end" },
      ],
      6000
    );
    expect(repaired.map((chapter) => chapter.title)).toEqual(["A"]);
  });
});

describe("mock analysis", () => {
  it("is deterministic, spans the duration, and suggests every speaker", async () => {
    vi.stubEnv("ANALYSIS_PROVIDER", "mock");
    const input = { contextPack: pack, durationMs: 6000, transcript };
    const a = await runSourceAnalysis(input);
    const b = await runSourceAnalysis(input);
    expect(a).toEqual(b);
    expect(a.chapters).toHaveLength(3);
    expect(a.chapters[0]?.startMs).toBe(0);
    expect(a.chapters.at(-1)?.endMs).toBe(6000);
    expect(a.editorial.speakers.map((s) => s.speaker)).toEqual(["0", "1"]);
    expect(a.usage).toEqual([]);
  });
});

describe("context pack hashing", () => {
  it("is stable across property order", () => {
    // Same content, insertion order reversed at runtime (so no formatter
    // can sort it back) at both levels
    const reordered = Object.fromEntries(
      Object.entries({
        ...pack,
        source: Object.fromEntries(
          Object.entries(pack.source).reverse()
        ) as SourceContextPack["source"],
      }).reverse()
    ) as unknown as SourceContextPack;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(pack));
    expect(hashContextPack(pack)).toBe(hashContextPack(reordered));
    expect(canonicalJson(pack)).toBe(canonicalJson(reordered));
  });

  it("changes when content changes", () => {
    expect(
      hashContextPack({ ...pack, source: { ...pack.source, title: "Other" } })
    ).not.toBe(hashContextPack(pack));
  });
});
