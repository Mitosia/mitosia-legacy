import { describe, expect, it } from "vitest";
import type { RawSegmentItem } from "@/lib/ai/capabilities/segment-plan";
import { buildCutGrid } from "@/lib/intelligence/grid";
import { applySegmentCutProposals } from "@/lib/intelligence/segment-cuts";
import type { TranscriptWord } from "@/lib/transcription/types";

// Segment Cutters run in parallel, but their answers become timeline changes
// only here. A model may select a sentence it was shown; it may not hallucinate
// another ID, move across a neighboring rough boundary, or cross another
// Cutter's answer.

function makeTimeline(count: number): TranscriptWord[] {
  return Array.from({ length: count }, (_, index) => ({
    confidence: 0.99,
    endMs: index * 1000 + 500,
    speaker: String(index % 2),
    startMs: index * 1000,
    text: `Sentence-${index}.`,
  }));
}

function keep(startMs: number, endMs: number, title: string): RawSegmentItem {
  return {
    anchorText: `${title} anchor`,
    dropReason: null,
    endMs,
    hook: `${title} hook`,
    kind: "keep",
    startMs,
    summary: `${title} summary`,
    title,
  };
}

const GRID = buildCutGrid(makeTimeline(10));
const ITEMS = [
  keep(0, 3000, "One"),
  keep(3000, 6000, "Two"),
  keep(6000, 9000, "Three"),
  keep(9000, 9500, "Four"),
];
const WHOLE_REEL = { fromSentence: 0, toSentence: 9 };

describe("applySegmentCutProposals", () => {
  it("applies a sentence ID inside its rendered window and neighbor bounds", () => {
    const result = applySegmentCutProposals(ITEMS, GRID, [
      {
        cutId: 4,
        itemIndex: 1,
        window: { fromSentence: 3, toSentence: 5 },
      },
    ]);

    expect(result).toMatchObject({
      applied: 1,
      atomicFallback: false,
      rejected: 0,
    });
    expect(result.items.map((item) => item.startMs)).toEqual([
      0, 4000, 6000, 9000,
    ]);
  });

  it("rejects a real sentence ID that was outside the rendered window", () => {
    const result = applySegmentCutProposals(ITEMS, GRID, [
      {
        cutId: 1,
        itemIndex: 1,
        window: { fromSentence: 3, toSentence: 5 },
      },
    ]);

    expect(result).toMatchObject({
      applied: 0,
      atomicFallback: false,
      rejected: 1,
    });
    expect(result.items).toEqual(ITEMS);
  });

  it("rejects nonexistent, noninteger, and unknown-target IDs without clamping", () => {
    const proposals = [
      { cutId: -1, itemIndex: 1, window: WHOLE_REEL },
      { cutId: 99, itemIndex: 1, window: WHOLE_REEL },
      { cutId: 3.5, itemIndex: 1, window: WHOLE_REEL },
      { cutId: 3, itemIndex: 99, window: WHOLE_REEL },
    ];

    for (const proposal of proposals) {
      const result = applySegmentCutProposals(ITEMS, GRID, [proposal]);
      expect(result.applied).toBe(0);
      expect(result.rejected).toBe(1);
      expect(result.items).toEqual(ITEMS);
    }
  });

  it("rejects duplicate answers for one boundary", () => {
    const result = applySegmentCutProposals(ITEMS, GRID, [
      { cutId: 4, itemIndex: 1, window: WHOLE_REEL },
      { cutId: 5, itemIndex: 1, window: WHOLE_REEL },
    ]);

    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(2);
    expect(result.items).toEqual(ITEMS);
  });

  it("rejects a cut that crosses a neighboring rough boundary", () => {
    const result = applySegmentCutProposals(ITEMS, GRID, [
      // Boundary 1 belongs between original starts 0 and 6000.
      { cutId: 7, itemIndex: 1, window: WHOLE_REEL },
    ]);

    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.items).toEqual(ITEMS);
  });

  it("falls back atomically when individually valid parallel cuts cross", () => {
    const result = applySegmentCutProposals(ITEMS, GRID, [
      // Both stay inside their original neighboring starts, but together
      // they would reorder chapters Two and Three: 5000 then 4000.
      { cutId: 5, itemIndex: 1, window: WHOLE_REEL },
      { cutId: 4, itemIndex: 2, window: WHOLE_REEL },
    ]);

    expect(result).toMatchObject({
      applied: 0,
      atomicFallback: true,
      rejected: 2,
    });
    expect(result.items).toEqual(ITEMS);
  });
});
