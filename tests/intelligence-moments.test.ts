import { describe, expect, it } from "vitest";
import {
  buildMomentRows,
  compositeScore,
  dedupeCandidates,
  MOMENT_COMPOSITE_WEIGHTS,
  type MomentScores,
  pauseBoundaries,
  type RawMomentCandidate,
  sentenceEndTimes,
  sentenceStarts,
  sentenceStartTimes,
  snapToSentences,
} from "../lib/intelligence/moments";
import type { TranscriptWord } from "../lib/transcription/types";

// The deterministic gauntlet every discovery candidate runs (D3): snapping
// to the sentence grid, anchor grounding, dedupe, composite ranking. These
// bounds are what plays in the review UI, so boundary correctness is
// load-bearing — same stakes as the chunker tests.

function makeWords(
  sentences: { gapMs?: number; words: string[] }[]
): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let cursor = 0;
  for (const sentence of sentences) {
    cursor += sentence.gapMs ?? 200;
    for (const text of sentence.words) {
      out.push({
        confidence: 0.95,
        endMs: cursor + 250,
        speaker: "0",
        startMs: cursor,
        text,
      });
      cursor += 300;
    }
  }
  return out;
}

const THREE_SENTENCES = makeWords([
  { words: ["One", "two", "three."] },
  { words: ["Four", "five", "six."] },
  { words: ["Seven", "eight", "nine."] },
]);

const scores = (overrides: Partial<MomentScores> = {}): MomentScores => ({
  comprehensibility: 0.8,
  hook: 0.8,
  insight: 0.8,
  relevance: 0.8,
  risk: 0.1,
  ...overrides,
});

describe("sentence grid", () => {
  it("marks the first word and every word after terminal punctuation", () => {
    expect(sentenceStarts(THREE_SENTENCES)).toEqual([0, 3, 6]);
  });

  it("treats trailing quotes after punctuation as sentence ends", () => {
    const words = makeWords([
      { words: ["He", "said", 'no."'] },
      { words: ["Then", "left."] },
    ]);
    expect(sentenceStarts(words)).toEqual([0, 3]);
  });

  it("derives start times from first words and end times from last words", () => {
    const starts = sentenceStartTimes(THREE_SENTENCES);
    const ends = sentenceEndTimes(THREE_SENTENCES);
    expect(starts).toEqual([
      THREE_SENTENCES[0]?.startMs,
      THREE_SENTENCES[3]?.startMs,
      THREE_SENTENCES[6]?.startMs,
    ]);
    expect(ends).toEqual([
      THREE_SENTENCES[2]?.endMs,
      THREE_SENTENCES[5]?.endMs,
      THREE_SENTENCES[8]?.endMs,
    ]);
  });

  it("finds pauses at or above the gap threshold only", () => {
    const words = makeWords([
      { words: ["Alpha", "beta"] },
      { gapMs: 800, words: ["gamma", "delta."] },
    ]);
    expect(pauseBoundaries(words, 700)).toEqual([2]);
    expect(pauseBoundaries(words, 900)).toEqual([]);
  });
});

describe("snapToSentences", () => {
  it("expands a mid-sentence range to the sentence boundaries", () => {
    const secondStart = THREE_SENTENCES[3].startMs;
    const secondEnd = THREE_SENTENCES[5].endMs;
    const snapped = snapToSentences(
      { endMs: secondEnd - 300, startMs: secondStart + 350 },
      THREE_SENTENCES
    );
    expect(snapped).toEqual({ endMs: secondEnd, startMs: secondStart });
  });

  it("keeps the raw bound when the nearest sentence start exceeds the growth cap", () => {
    // One 40-word run with no terminal punctuation: the only sentence start
    // is >10s behind the range.
    const longRun = makeWords([
      { words: Array.from({ length: 40 }, (_, i) => `w${i}`) },
    ]);
    const rangeStart = longRun[35].startMs + 100;
    const snapped = snapToSentences(
      { endMs: rangeStart + 1000, startMs: rangeStart },
      longRun
    );
    expect(snapped.startMs).toBe(rangeStart);
  });

  it("falls back to a pause boundary when sentence starts are out of reach", () => {
    const words = makeWords([
      { words: Array.from({ length: 40 }, (_, i) => `a${i}`) },
      { gapMs: 800, words: Array.from({ length: 10 }, (_, i) => `b${i}`) },
    ]);
    const pauseStart = words[40].startMs;
    const rangeStart = words[45].startMs + 100;
    const snapped = snapToSentences(
      { endMs: rangeStart + 1000, startMs: rangeStart },
      words
    );
    expect(snapped.startMs).toBe(pauseStart);
  });

  it("clamps into the word timeline before snapping", () => {
    const lastEnd = THREE_SENTENCES.at(-1)?.endMs ?? 0;
    const snapped = snapToSentences(
      { endMs: lastEnd + 60_000, startMs: 0 },
      THREE_SENTENCES
    );
    expect(snapped.endMs).toBe(lastEnd);
    expect(snapped.startMs).toBe(THREE_SENTENCES[0]?.startMs);
  });
});

describe("compositeScore", () => {
  it("weights the four quality dimensions and ignores risk", () => {
    expect(
      compositeScore(
        scores({
          comprehensibility: 1,
          hook: 0,
          insight: 0,
          relevance: 0,
          risk: 1,
        })
      )
    ).toBeCloseTo(MOMENT_COMPOSITE_WEIGHTS.comprehensibility);
    expect(
      compositeScore(
        scores({
          comprehensibility: 0,
          hook: 1,
          insight: 0,
          relevance: 0,
          risk: 0,
        })
      )
    ).toBeCloseTo(MOMENT_COMPOSITE_WEIGHTS.hook);
    expect(
      compositeScore(
        scores({ comprehensibility: 1, hook: 1, insight: 1, relevance: 1 })
      )
    ).toBeCloseTo(1);
  });
});

describe("dedupeCandidates", () => {
  it("groups overlapping ranges and keeps the highest composite", () => {
    const verdicts = dedupeCandidates(
      [
        { composite: 0.9, endMs: 10_000, startMs: 0 },
        { composite: 0.7, endMs: 10_500, startMs: 500 },
        { composite: 0.8, endMs: 30_000, startMs: 20_000 },
      ],
      []
    );
    expect(verdicts[0]).toEqual({ dedupeGroup: 0, suppressed: false });
    expect(verdicts[1]).toEqual({ dedupeGroup: 0, suppressed: true });
    expect(verdicts[2]).toEqual({ dedupeGroup: null, suppressed: false });
  });

  it("merges disjoint ranges whose chunk vectors agree (the twice-told story)", () => {
    const verdicts = dedupeCandidates(
      [
        { composite: 0.9, endMs: 10_000, startMs: 0 },
        { composite: 0.7, endMs: 30_000, startMs: 20_000 },
        { composite: 0.8, endMs: 50_000, startMs: 40_000 },
      ],
      [
        { embedding: [1, 0, 0], endMs: 10_000, startMs: 0 },
        { embedding: [0.99, 0.05, 0], endMs: 30_000, startMs: 20_000 },
        { embedding: [0, 1, 0], endMs: 50_000, startMs: 40_000 },
      ]
    );
    expect(verdicts[0]).toEqual({ dedupeGroup: 0, suppressed: false });
    expect(verdicts[1]).toEqual({ dedupeGroup: 0, suppressed: true });
    expect(verdicts[2]).toEqual({ dedupeGroup: null, suppressed: false });
  });

  it("never merges neighbors that share one chunk footprint", () => {
    // Two distinct beats inside a single chunk have identical mean vectors
    // by construction — that is not evidence they are the same moment.
    const verdicts = dedupeCandidates(
      [
        { composite: 0.9, endMs: 4000, startMs: 0 },
        { composite: 0.8, endMs: 9000, startMs: 5000 },
      ],
      [{ embedding: [1, 0, 0], endMs: 10_000, startMs: 0 }]
    );
    expect(verdicts.every((verdict) => !verdict.suppressed)).toBe(true);
  });
});

describe("buildMomentRows", () => {
  const item = (
    overrides: Partial<RawMomentCandidate> & { anchorText: string }
  ): RawMomentCandidate => ({
    endMs: 0,
    hook: "Hook.",
    scores: scores(),
    seedIds: [],
    startMs: 0,
    summary: "Summary.",
    title: "Title",
    ...overrides,
  });
  const durationMs = (THREE_SENTENCES.at(-1)?.endMs ?? 0) + 200;
  const s2 = {
    endMs: THREE_SENTENCES[5].endMs,
    startMs: THREE_SENTENCES[3].startMs,
  };

  it("grounds anchors inside the snapped range and rejects anchors outside it", () => {
    const rows = buildMomentRows(
      [
        item({ anchorText: "Four five six", ...s2 }),
        // Verbatim words, but from sentence 1 — the aligner finds them
        // OUTSIDE the claimed range, so the candidate never surfaces.
        item({ anchorText: "One two three", ...s2 }),
      ],
      THREE_SENTENCES,
      durationMs,
      []
    );
    const grounded = rows.filter((row) => row.grounded);
    expect(grounded).toHaveLength(1);
    expect(grounded[0]?.anchorText).toBe("Four five six");
    expect(grounded[0]?.startMs).toBe(s2.startMs);
    expect(grounded[0]?.endMs).toBe(s2.endMs);
    // Ungrounded rows rank after everything grounded.
    expect(rows.at(-1)?.grounded).toBe(false);
  });

  it("snaps model ranges, keeps the raw claim, and flags risk", () => {
    const rows = buildMomentRows(
      [
        item({
          anchorText: "Four five",
          endMs: s2.endMs - 100,
          scores: scores({ risk: 0.8 }),
          startMs: s2.startMs + 150,
        }),
      ],
      THREE_SENTENCES,
      durationMs,
      []
    );
    expect(rows[0]?.startMs).toBe(s2.startMs);
    expect(rows[0]?.endMs).toBe(s2.endMs);
    expect(rows[0]?.rawStartMs).toBe(s2.startMs + 150);
    expect(rows[0]?.rawEndMs).toBe(s2.endMs - 100);
    expect(rows[0]?.sensitive).toBe(true);
  });

  it("suppresses duplicates, ranks survivors by composite, and is deterministic", () => {
    const items = [
      item({
        anchorText: "One two three",
        endMs: THREE_SENTENCES[2].endMs,
        scores: scores({ hook: 0.9 }),
        startMs: 0,
      }),
      item({
        anchorText: "Seven eight nine",
        endMs: THREE_SENTENCES[8].endMs,
        scores: scores({ hook: 1 }),
        startMs: THREE_SENTENCES[6].startMs,
      }),
      // Same span as the first, weaker scores — loses its dedupe group.
      item({
        anchorText: "One two",
        endMs: THREE_SENTENCES[2].endMs,
        scores: scores({ hook: 0.2, insight: 0.2 }),
        startMs: 0,
      }),
    ];
    const rows = buildMomentRows(items, THREE_SENTENCES, durationMs, []);
    expect(rows.map((row) => row.rank)).toEqual([0, 1, 2]);
    expect(rows[0]?.anchorText).toBe("Seven eight nine");
    expect(rows[0]?.suppressed).toBe(false);
    expect(rows[1]?.anchorText).toBe("One two three");
    expect(rows[1]?.dedupeGroup).toBe(rows[2]?.dedupeGroup);
    expect(rows[2]?.suppressed).toBe(true);

    const again = buildMomentRows(items, THREE_SENTENCES, durationMs, []);
    expect(again).toEqual(rows);
  });
});
