import { describe, expect, it } from "vitest";
import { buildCutGrid, type CutGrid } from "@/lib/intelligence/grid";
import {
  compilePublisherPlan,
  numberPublisherDraftSegments,
  type PublisherPlanSlice,
  validatePublisherKeepCoverage,
} from "@/lib/intelligence/segment-publisher";
import type { SegmentRow } from "@/lib/intelligence/segments";
import type { TranscriptWord } from "@/lib/transcription/types";

function makeGrid(sentenceCount: number): CutGrid {
  const words: TranscriptWord[] = Array.from(
    { length: sentenceCount },
    (_, index) => ({
      confidence: 0.99,
      endMs: index * 1000 + 600,
      speaker: String(index % 2),
      startMs: index * 1000,
      text: `Sentence ${index}.`,
    })
  );
  return buildCutGrid(words);
}

function keepRow(
  grid: CutGrid,
  startSentenceId: number,
  endSentenceId: number,
  title: string,
  idx: number
): SegmentRow {
  const start = grid.sentences[startSentenceId];
  const end = grid.sentences[endSentenceId];
  if (!(start && end)) {
    throw new Error("test row is outside the grid");
  }
  return {
    anchorText: `${title} anchor`,
    dropReason: null,
    endMs: end.endMs,
    flags: [],
    grounded: true,
    groundingScore: 1,
    hook: `${title} hook`,
    idx,
    kind: "keep",
    rawEndMs: end.endMs,
    rawStartMs: start.startMs,
    startMs: start.startMs,
    summary: `${title} summary`,
    title,
  };
}

function keepSlice(
  startSentenceId: number,
  endSentenceId: number,
  sourceIds: string[],
  title: string,
  reasonCode: PublisherPlanSlice["reasonCode"] = "unchanged"
): PublisherPlanSlice {
  return {
    anchorText: `${title} anchor`,
    dropReason: null,
    endSentenceId,
    hook: `${title} hook`,
    kind: "keep",
    reasonCode,
    reasoning: "This is a complete editorial chapter.",
    sourceIds,
    startSentenceId,
    summary: `${title} summary`,
    title,
  };
}

function dropSlice(
  startSentenceId: number,
  endSentenceId: number,
  sourceIds: string[]
): PublisherPlanSlice {
  return {
    anchorText: null,
    dropReason: "thin",
    endSentenceId,
    hook: null,
    kind: "drop",
    reasonCode: "split_transition",
    reasoning: "This sentence is connective filler, not a chapter.",
    sourceIds,
    startSentenceId,
    summary: null,
    title: null,
  };
}

describe("numberPublisherDraftSegments", () => {
  it("numbers draft rows chronologically and records exact sentence coverage", () => {
    const grid = makeGrid(6);
    const late = keepRow(grid, 3, 5, "Late", 1);
    const early = keepRow(grid, 0, 2, "Early", 0);

    const result = numberPublisherDraftSegments([late, early], grid);

    expect(result.issues).toEqual([]);
    expect(
      result.segments.map(({ endSentenceId, id, startSentenceId }) => ({
        endSentenceId,
        id,
        startSentenceId,
      }))
    ).toEqual([
      { endSentenceId: 2, id: "SEG000", startSentenceId: 0 },
      { endSentenceId: 5, id: "SEG001", startSentenceId: 3 },
    ]);
  });
});

describe("validatePublisherKeepCoverage", () => {
  it("rejects a marquee arc that is wholly classified as DROP", () => {
    const grid = makeGrid(6);
    const dropped = {
      ...keepRow(grid, 3, 5, "Dropped arc", 1),
      anchorText: null,
      dropReason: "thin" as const,
      grounded: true,
      hook: null,
      kind: "drop" as const,
      summary: null,
      title: null,
    };
    const numbered = numberPublisherDraftSegments(
      [keepRow(grid, 0, 2, "Retained", 0), dropped],
      grid
    );

    expect(
      validatePublisherKeepCoverage(numbered.segments, grid, [
        {
          endSentenceId: 5,
          id: "ARC000",
          label: "Dropped arc",
          startSentenceId: 3,
        },
      ])
    ).toContainEqual({
      code: "dropped_coverage",
      message: "ARC000 (Dropped arc) is wholly classified as DROP",
    });
  });
});

describe("compilePublisherPlan", () => {
  it("merges a dependent Karma-shaped neighbour pair atomically", () => {
    const grid = makeGrid(9);
    const draft = [
      keepRow(grid, 0, 2, "Opening", 0),
      keepRow(grid, 3, 5, "Choice", 1),
      keepRow(grid, 6, 8, "Life goes on", 2),
    ];

    const result = compilePublisherPlan(draft, grid, [
      keepSlice(0, 2, ["SEG000"], "Opening"),
      keepSlice(
        3,
        8,
        ["SEG001", "SEG002"],
        "Choice and what follows",
        "merge_false_boundary"
      ),
    ]);

    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[1]).toMatchObject({
      endMs: 8600,
      startMs: 3000,
      title: "Choice and what follows",
    });
    expect(result.counts.merge).toBe(1);
    expect(result.operations).toContainEqual({
      outputIndex: 1,
      sourceIds: ["SEG001", "SEG002"],
      type: "merge",
    });
  });

  it("splits a transition out of a keep and changes its disposition", () => {
    const grid = makeGrid(7);
    const draft = [keepRow(grid, 0, 6, "Providence and books", 0)];

    const result = compilePublisherPlan(draft, grid, [
      keepSlice(0, 3, ["SEG000"], "Providence"),
      dropSlice(4, 4, ["SEG000"]),
      keepSlice(5, 6, ["SEG000"], "Books"),
    ]);

    expect(result.ok).toBe(true);
    expect(result.items.map((item) => item.kind)).toEqual([
      "keep",
      "drop",
      "keep",
    ]);
    expect(result.counts.split).toBe(1);
    expect(result.counts.set_disposition).toBe(1);
    expect(result.operations).toContainEqual({
      fromKinds: ["keep"],
      outputIndex: 1,
      sourceIds: ["SEG000"],
      toKind: "drop",
      type: "set_disposition",
    });
  });

  it("moves an exact sentence boundary while retaining chronological lineage", () => {
    const grid = makeGrid(8);
    const draft = [
      keepRow(grid, 0, 3, "Carryover", 0),
      keepRow(grid, 4, 7, "Complete answer", 1),
    ];

    const result = compilePublisherPlan(draft, grid, [
      keepSlice(0, 2, ["SEG000"], "Carryover"),
      keepSlice(3, 7, ["SEG000", "SEG001"], "Complete answer", "restore_setup"),
    ]);

    expect(result.ok).toBe(true);
    expect(result.counts.move_boundary).toBe(1);
    expect(result.counts.repackage).toBe(0);
    expect(result.operations).toContainEqual({
      fromSentenceId: 4,
      leftSourceId: "SEG000",
      outputBoundaryIndex: 1,
      rightSourceId: "SEG001",
      toSentenceId: 3,
      type: "move_boundary",
    });
  });

  it("audits publisher retitling as repackage", () => {
    const grid = makeGrid(4);
    const draft = [keepRow(grid, 0, 3, "Wealth", 0)];

    const result = compilePublisherPlan(draft, grid, [
      keepSlice(0, 3, ["SEG000"], "What wealth cannot buy", "repackage"),
    ]);

    expect(result.ok).toBe(true);
    expect(result.counts.repackage).toBe(1);
    expect(result.operations).toContainEqual({
      changedFields: ["anchorText", "hook", "summary", "title"],
      outputIndex: 0,
      sourceIds: ["SEG000"],
      type: "repackage",
    });
  });

  it("rejects gaps, overlaps, and incomplete outer coverage without applying anything", () => {
    const grid = makeGrid(6);
    const draft = [
      keepRow(grid, 0, 2, "First", 0),
      keepRow(grid, 3, 5, "Second", 1),
    ];
    const invalidPlans: PublisherPlanSlice[][] = [
      [
        keepSlice(0, 1, ["SEG000"], "First"),
        keepSlice(3, 5, ["SEG001"], "Second"),
      ],
      [
        keepSlice(0, 3, ["SEG000"], "First"),
        keepSlice(3, 5, ["SEG001"], "Second"),
      ],
      [
        keepSlice(1, 2, ["SEG000"], "First"),
        keepSlice(3, 4, ["SEG001"], "Second"),
      ],
    ];

    for (const slices of invalidPlans) {
      const result = compilePublisherPlan(draft, grid, slices);
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.items).toEqual([]);
      expect(result.operations).toEqual([]);
    }
  });

  it("rejects unknown, noncontiguous, missing, or backward source lineage", () => {
    const grid = makeGrid(9);
    const draft = [
      keepRow(grid, 0, 2, "One", 0),
      keepRow(grid, 3, 5, "Two", 1),
      keepRow(grid, 6, 8, "Three", 2),
    ];
    const invalidPlans: PublisherPlanSlice[][] = [
      [keepSlice(0, 8, ["SEG000", "SEG999"], "Unknown")],
      [keepSlice(0, 8, ["SEG000", "SEG002"], "Skipped")],
      [
        keepSlice(0, 2, ["SEG001"], "Backward one"),
        keepSlice(3, 5, ["SEG000"], "Backward two"),
        keepSlice(6, 8, ["SEG002"], "Three"),
      ],
      // Every source is claimed, but the moved boundary's first slice omits
      // SEG001 even though its range consumes one of SEG001's sentences.
      [
        keepSlice(0, 3, ["SEG000"], "Incomplete provenance"),
        keepSlice(4, 5, ["SEG001"], "Two"),
        keepSlice(6, 8, ["SEG002"], "Three"),
      ],
    ];

    for (const slices of invalidPlans) {
      const result = compilePublisherPlan(draft, grid, slices);
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.items).toEqual([]);
    }
  });

  it("rejects keep/drop packaging violations", () => {
    const grid = makeGrid(4);
    const draft = [keepRow(grid, 0, 3, "Topic", 0)];
    const incompleteKeep = {
      ...keepSlice(0, 3, ["SEG000"], "Topic"),
      anchorText: null,
    };
    const packagedDrop = {
      ...dropSlice(0, 3, ["SEG000"]),
      title: "Not allowed",
    };

    for (const slices of [[incompleteKeep], [packagedDrop]]) {
      const result = compilePublisherPlan(draft, grid, slices);
      expect(result.ok).toBe(false);
      expect(result.items).toEqual([]);
      expect(
        result.issues.some((issue) => issue.code.endsWith("_packaging"))
      ).toBe(true);
    }
  });

  it("rejects an exact-cover plan that drops the entire episode", () => {
    const grid = makeGrid(4);
    const draft = [keepRow(grid, 0, 3, "Topic", 0)];

    const result = compilePublisherPlan(draft, grid, [
      dropSlice(0, 3, ["SEG000"]),
    ]);

    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.issues).toContainEqual({
      code: "empty_keep_plan",
      message: "publisher plan must retain at least one chapter",
    });
  });
});
