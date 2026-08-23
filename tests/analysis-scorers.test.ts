import { describe, expect, it } from "vitest";
import {
  scoreChapters,
  scoreSpeakerSuggestions,
  scoreSummary,
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
