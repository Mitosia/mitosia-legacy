import { describe, expect, it } from "vitest";
import { applyMomentFineCut } from "@/lib/intelligence/fine-cut";
import {
  buildCutGrid,
  captureLeadInTwoTurn,
  cutterWindow,
  leadOutTrim,
  pauseAirExtend,
  renderCoarse,
  renderFine,
  resolveParagraphSpan,
  resolveSpan,
  shotSnap,
  staleOpenFlag,
} from "@/lib/intelligence/grid";
import { tokenizeWords } from "@/lib/intelligence/grounding";
import type { MomentRow } from "@/lib/intelligence/moments";
import { parseShotCsv } from "@/lib/media/shots";
import type { TranscriptWord } from "@/lib/transcription/types";

// The cut-point substrate (docs/clip-cut-architecture.md §4 Pass 0) and
// the deterministic narrative backstops (§5), on constructed timelines
// where every expected boundary is hand-checkable.

function word(
  text: string,
  startMs: number,
  endMs: number,
  speaker: string
): TranscriptWord {
  return { confidence: 0.99, endMs, speaker, startMs, text };
}

// One sentence per phrase; words spaced 10ms apart inside a sentence.
function sentence(
  text: string,
  startMs: number,
  endMs: number,
  speaker: string
): TranscriptWord[] {
  const parts = text.split(" ");
  const step = (endMs - startMs) / parts.length;
  return parts.map((part, index) =>
    word(
      part,
      Math.round(startMs + index * step),
      index === parts.length - 1
        ? endMs
        : Math.round(startMs + (index + 1) * step) - 2,
      speaker
    )
  );
}

// An interview shape: S1 fragment, S1-adjacent question would merge, so
// the two-turn case uses an S2 fragment between S1 turns.
//   s0 S1 0-2000      "Tell me about the tour."        (question)
//   s1 S2 2200-3400   "Oh, the standoff?"              (short fragment)
//   s2 S1 3600-5600   "Yes, walk me through it."
//   s3 S2 5800-11800  "So we were in Mohali that day."  (the answer opens)
//   s4 S2 11810-17800 "I demanded the ball from Ricky."
//   s5 S2 17810-20000 "And he finally gave it to me."   (payoff; pause after)
//   s6 S1 21500-23000 "What happened next?"             (next question)
const TIMELINE: TranscriptWord[] = [
  ...sentence("Tell me about the tour.", 0, 2000, "0"),
  ...sentence("Oh, the standoff?", 2200, 3400, "1"),
  ...sentence("Yes, walk me through it.", 3600, 5600, "0"),
  ...sentence("So we were in Mohali that day.", 5800, 11_800, "1"),
  ...sentence("I demanded the ball from Ricky.", 11_810, 17_800, "1"),
  ...sentence("And he finally gave it to me.", 17_810, 20_000, "1"),
  ...sentence("What happened next?", 21_500, 23_000, "0"),
];

const GRID = buildCutGrid(TIMELINE);

describe("buildCutGrid", () => {
  it("tiles the words into annotated sentences", () => {
    expect(GRID.sentences).toHaveLength(7);
    expect(GRID.sentences[0]?.question).toBe(false);
    expect(GRID.sentences[1]?.question).toBe(true);
    expect(GRID.sentences[6]?.question).toBe(true);
    expect(GRID.sentences[3]?.opensTurn).toBe(true);
    expect(GRID.sentences[4]?.opensTurn).toBe(false);
    expect(GRID.sentences[5]?.endsTurn).toBe(true);
    // Silence between the payoff and the next question
    expect(GRID.sentences[5]?.pauseAfterMs).toBe(21_500 - 20_000);
  });

  it("packs paragraphs on speaker turns without splitting sentences", () => {
    // Speakers alternate 0/1/0/1(x3)/0 → five paragraphs
    expect(GRID.paragraphs).toHaveLength(5);
    expect(GRID.paragraphs[3]?.startSentence).toBe(3);
    expect(GRID.paragraphs[3]?.endSentence).toBe(5);
  });
});

describe("resolvers", () => {
  it("maps sentence IDs to exact word times", () => {
    const span = resolveSpan(GRID, 3, 5);
    expect(span).toEqual({ clamped: false, endMs: 20_000, startMs: 5800 });
  });

  it("clamps out-of-range and inverted IDs, flagged", () => {
    expect(resolveSpan(GRID, -2, 99)).toEqual({
      clamped: true,
      endMs: 23_000,
      startMs: 0,
    });
    const inverted = resolveSpan(GRID, 5, 3);
    expect(inverted.clamped).toBe(true);
    expect(inverted.endMs).toBeGreaterThan(inverted.startMs);
  });

  it("maps paragraph IDs to paragraph spans", () => {
    const span = resolveParagraphSpan(GRID, 3, 3);
    expect(span.startMs).toBe(5800);
    expect(span.endMs).toBe(20_000);
  });
});

describe("renderings", () => {
  it("coarse lines carry paragraph IDs and speaker tags", () => {
    const coarse = renderCoarse(GRID);
    expect(coarse).toContain("P000 [00:00] S1: Tell me about the tour.");
    expect(coarse).toContain("P003 [00:05] S2: So we were in Mohali");
  });

  it("fine lines carry sentence IDs, turn, question, and pause marks", () => {
    const fine = renderFine(GRID, 0, 6);
    expect(fine).toContain("s0001 [00:02] S2: Oh, the standoff?  ⟲turn ·q");
    expect(fine).toContain("¶1.5s");
    expect(fine.split("\n")).toHaveLength(7);
  });
});

describe("cutterWindow", () => {
  it("contains the two turns preceding the rough start", () => {
    // Rough range = the answer only (s3..s5); margin tiny to prove the
    // turn expansion does the work.
    const window = cutterWindow(GRID, { endMs: 20_000, startMs: 5800 }, 100);
    expect(window.fromSentence).toBeLessThanOrEqual(1);
    expect(window.toSentence).toBeGreaterThanOrEqual(6);
  });
});

describe("captureLeadInTwoTurn", () => {
  it("grows over the other-speaker setup and one short fragment", () => {
    const result = captureLeadInTwoTurn({ endMs: 20_000, startMs: 5800 }, GRID);
    expect(result.flags).toContain("lead_in_captured");
    // Two turns back: s2 (the question) then s1 (the fragment)
    expect(result.range.startMs).toBe(2200);
  });

  it("does nothing when the span does not open on a sentence start", () => {
    const result = captureLeadInTwoTurn({ endMs: 20_000, startMs: 6100 }, GRID);
    expect(result.flags).toHaveLength(0);
    expect(result.range.startMs).toBe(6100);
  });

  it("does not cross a long same-speaker predecessor", () => {
    // s4 opens mid-monologue (same speaker before it)
    const result = captureLeadInTwoTurn(
      { endMs: 20_000, startMs: 11_810 },
      GRID
    );
    expect(result.flags).toHaveLength(0);
  });
});

describe("leadOutTrim", () => {
  it("trims a span that ends on the next question", () => {
    const result = leadOutTrim({ endMs: 23_000, startMs: 5800 }, GRID);
    expect(result.flags).toContain("lead_out_trimmed");
    expect(result.range.endMs).toBe(20_000);
  });

  it("leaves a span ending on the payoff alone", () => {
    const result = leadOutTrim({ endMs: 20_000, startMs: 5800 }, GRID);
    expect(result.flags).toHaveLength(0);
  });
});

describe("staleOpenFlag", () => {
  it("flags a span opening on a turn-final sentence", () => {
    // s5 is the final sentence of S2's turn — the Preity-Zinta shape
    expect(staleOpenFlag({ endMs: 23_000, startMs: 17_810 }, GRID)).toBe(true);
  });

  it("does not flag a turn-opening start", () => {
    expect(staleOpenFlag({ endMs: 20_000, startMs: 5800 }, GRID)).toBe(false);
  });
});

describe("pauseAirExtend", () => {
  it("gives the payoff its air, capped at one pause gap", () => {
    const result = pauseAirExtend({ endMs: 20_000, startMs: 5800 }, GRID);
    // 1500ms of silence follows; the extension caps at 700ms
    expect(result.endMs).toBe(20_700);
  });

  it("does nothing when the span ends mid-sentence", () => {
    const result = pauseAirExtend({ endMs: 19_000, startMs: 5800 }, GRID);
    expect(result.endMs).toBe(19_000);
  });
});

describe("shotSnap", () => {
  it("snaps an in-point onto a camera cut in the preceding silence", () => {
    // Silence before s3 runs 5600→5800; a cut at 5700 is snappable
    const result = shotSnap({ endMs: 20_000, startMs: 5800 }, GRID, [5700]);
    expect(result.flags).toContain("shot_snapped");
    expect(result.range.startMs).toBe(5700);
  });

  it("never snaps across speech", () => {
    // 5500 is inside the previous sentence's words
    const result = shotSnap({ endMs: 20_000, startMs: 5800 }, GRID, [5500]);
    expect(result.flags).toHaveLength(0);
    expect(result.range.startMs).toBe(5800);
  });

  it("snaps an out-point into the following pause", () => {
    const result = shotSnap({ endMs: 20_000, startMs: 5800 }, GRID, [20_300]);
    expect(result.range.endMs).toBe(20_300);
  });
});

describe("applyMomentFineCut", () => {
  const tokens = tokenizeWords(TIMELINE);
  const baseRow: MomentRow = {
    anchorText: "we were in Mohali",
    composite: 0.8,
    dedupeGroup: null,
    endMs: 20_000,
    flags: [],
    grounded: true,
    groundingScore: 1,
    hook: "hook",
    rank: 0,
    rawEndMs: 20_000,
    rawStartMs: 5800,
    scores: {
      comprehensibility: 0.8,
      hook: 0.8,
      insight: 0.8,
      relevance: 0.8,
      risk: 0.1,
    },
    seedIds: [],
    sensitive: false,
    startMs: 5800,
    summary: "summary",
    suppressed: false,
    title: "title",
  };

  it("applies a clean cut through the backstop chain", () => {
    const updated = applyMomentFineCut(
      { ...baseRow, endMs: 23_000, startMs: 11_810 },
      {
        couldNotFind: false,
        inId: 3,
        outId: 5,
        payoffId: 5,
        reasoning: "setup at s3, payoff at s5",
        setupId: 3,
      },
      GRID,
      [],
      tokens
    );
    // Lead-in capture walks two turns back; pause air extends the close
    expect(updated.startMs).toBe(2200);
    expect(updated.endMs).toBe(20_700);
    expect(updated.grounded).toBe(true);
    expect(updated.flags).toContain("lead_in_captured");
  });

  it("rejects a payoff outside the cut, keeping coarse bounds", () => {
    const updated = applyMomentFineCut(
      baseRow,
      {
        couldNotFind: false,
        inId: 3,
        outId: 4,
        payoffId: 6,
        reasoning: "bad",
        setupId: 3,
      },
      GRID,
      [],
      tokens
    );
    expect(updated.flags).toContain("payoff_invariant");
    expect(updated.startMs).toBe(baseRow.startMs);
    expect(updated.endMs).toBe(baseRow.endMs);
  });

  it("records the escape hatch as a flag", () => {
    const updated = applyMomentFineCut(
      baseRow,
      {
        couldNotFind: true,
        inId: null,
        outId: null,
        payoffId: null,
        reasoning: "two stories here",
        setupId: null,
      },
      GRID,
      [],
      tokens
    );
    expect(updated.flags).toContain("no_single_payoff");
  });

  it("keeps the grounded coarse cut when the fine cut un-grounds", () => {
    const updated = applyMomentFineCut(
      baseRow,
      // A cut that excludes the anchor entirely
      {
        couldNotFind: false,
        inId: 0,
        outId: 1,
        payoffId: 1,
        reasoning: "drifted",
        setupId: 0,
      },
      GRID,
      [],
      tokens
    );
    expect(updated.flags).toContain("refine_ungrounded");
    expect(updated.startMs).toBe(baseRow.startMs);
    expect(updated.grounded).toBe(true);
  });

  it("flags an outright Cutter failure as unrefined", () => {
    const updated = applyMomentFineCut(baseRow, null, GRID, [], tokens);
    expect(updated.flags).toContain("unrefined");
  });
});

describe("parseShotCsv", () => {
  it("parses pts/score lines and drops sub-floor rows", () => {
    const events = parseShotCsv("4.000000,0.732716\n8.5,0.05\n9.25,0.31\n\n");
    expect(events).toEqual([
      { score: 0.732_716, timeMs: 4000 },
      { score: 0.31, timeMs: 9250 },
    ]);
  });
});
