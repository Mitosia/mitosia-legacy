import { describe, expect, it } from "vitest";
import {
  scoreChapters,
  scoreSegmentBoundaries,
  scoreSpeakerSuggestions,
  scoreSummary,
  segmentBoundaryDecisions,
} from "../lib/ai/evals/scorers";

const goodChapters = [
  { endMs: 5000, startMs: 0, summary: "a", title: "Opening" },
  { endMs: 10_000, startMs: 5000, summary: "b", title: "Middle" },
];

describe("scoreChapters", () => {
  it("scores full ordered coverage at 1", () => {
    const report = scoreChapters(goodChapters, 10_000);
    expect(report.score).toBe(1);
    expect(report.issues).toEqual([]);
  });

  it("penalizes gaps and early endings", () => {
    const report = scoreChapters(
      [{ endMs: 4000, startMs: 0, summary: "a", title: "Only" }],
      10_000
    );
    expect(report.score).toBeLessThan(0.7);
    expect(report.issues.join(" ")).toContain("cover only");
    expect(report.issues.join(" ")).toContain("ends well before");
  });

  it("halves the score for out-of-order chapters", () => {
    const report = scoreChapters(
      [
        { endMs: 10_000, startMs: 3000, summary: "b", title: "B" },
        { endMs: 5000, startMs: 0, summary: "a", title: "A" },
      ],
      10_000
    );
    expect(report.issues.join(" ")).toContain("overlap");
    expect(report.score).toBeLessThanOrEqual(0.65);
  });

  it("fails empty output", () => {
    expect(scoreChapters([], 10_000).score).toBe(0);
  });
});

describe("scoreSpeakerSuggestions", () => {
  const suggestion = (overrides: Record<string, unknown>) => ({
    confidence: 0.9,
    evidence: "I'm Marcus Webb",
    mergeWith: null,
    speaker: "0",
    suggestedName: "Marcus Webb",
    ...overrides,
  });

  it("passes complete, well-formed suggestions", () => {
    const report = scoreSpeakerSuggestions(
      [suggestion({}), suggestion({ speaker: "1", suggestedName: null })],
      ["0", "1"]
    );
    expect(report.score).toBe(1);
  });

  it("flags missing speakers, unknown ids, and evidence-free names", () => {
    const report = scoreSpeakerSuggestions(
      [
        suggestion({ evidence: " " }),
        suggestion({ mergeWith: "9", speaker: "7" }),
      ],
      ["0", "1"]
    );
    expect(report.issues.join(" ")).toContain("no suggestion entry");
    expect(report.issues.join(" ")).toContain("unknown speaker id 7");
    expect(report.issues.join(" ")).toContain("merge target 9");
    expect(report.issues.join(" ")).toContain("no evidence");
    expect(report.score).toBeLessThan(0.6);
  });
});

describe("scoreSummary", () => {
  it("passes a real executive summary", () => {
    const report = scoreSummary(
      "The episode examines organic growth strategy at Lumen Robotics. Marcus Webb explains how the team abandoned volume posting. A weekly flagship interview became the anchor format, tripling reach."
    );
    expect(report.score).toBe(1);
  });

  it("flags one-liners and markdown", () => {
    expect(scoreSummary("Too short.").issues.length).toBeGreaterThan(0);
    expect(
      scoreSummary(
        "## Heading\nA summary with markdown that is otherwise long enough to pass the length gate. It even has two sentences."
      ).issues.join(" ")
    ).toContain("markdown");
  });
});

describe("scoreSegmentBoundaries", () => {
  const atoms = [{ atomId: "A000" }, { atomId: "A001" }, { atomId: "A002" }];

  it("derives keep/remove decisions from exact-cover groups", () => {
    expect(
      segmentBoundaryDecisions(atoms, [
        { atomIds: ["A000", "A001"] },
        { atomIds: ["A002"] },
      ])
    ).toEqual([
      { afterAtomId: "A000", keep: false },
      { afterAtomId: "A001", keep: true },
    ]);
  });

  it("passes a plan that matches both boundary classes", () => {
    const decisions = [
      { afterAtomId: "A000", keep: false },
      { afterAtomId: "A001", keep: true },
    ];

    expect(scoreSegmentBoundaries(decisions, decisions)).toEqual({
      issues: [],
      score: 1,
    });
  });

  it("catches uniform over-fragmentation without a duration threshold", () => {
    const report = scoreSegmentBoundaries(
      [
        { afterAtomId: "A000", keep: true },
        { afterAtomId: "A001", keep: true },
      ],
      [
        {
          afterAtomId: "A000",
          keep: false,
          note: "question and direct answer",
        },
        { afterAtomId: "A001", keep: true, note: "new subject" },
      ]
    );

    expect(report.score).toBe(0.5);
    expect(report.issues.join(" ")).toContain("gold removes");
  });

  it("penalizes over-merging symmetrically", () => {
    const report = scoreSegmentBoundaries(
      [
        { afterAtomId: "A000", keep: false },
        { afterAtomId: "A001", keep: false },
      ],
      [
        { afterAtomId: "A000", keep: false },
        { afterAtomId: "A001", keep: true, note: "new subject" },
      ]
    );

    expect(report.score).toBe(0.5);
    expect(report.issues.join(" ")).toContain("gold keeps");
  });

  it("scores only the high-confidence boundaries supplied by a fixture", () => {
    const report = scoreSegmentBoundaries(
      [
        { afterAtomId: "A000", keep: true },
        { afterAtomId: "A001", keep: false },
      ],
      [{ afterAtomId: "A001", keep: false }]
    );

    expect(report).toEqual({ issues: [], score: 1 });
  });

  it("rejects an incomplete reconciliation inventory", () => {
    expect(() =>
      segmentBoundaryDecisions(atoms, [{ atomIds: ["A000", "A002"] }])
    ).toThrow("A001 is missing");
  });
});
