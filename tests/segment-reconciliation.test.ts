import { describe, expect, it } from "vitest";
import type { RawSegmentItem } from "@/lib/ai/capabilities/segment-plan";
import {
  applySegmentGrouping,
  numberSegmentAtoms,
  validateSegmentGrouping,
} from "@/lib/intelligence/segment-reconcile";

// Chapter reconciliation may remove rough boundaries, but never rewrite the
// timeline. The semantic model must return an exact, ordered grouping of
// deterministic atoms: every atom appears once, groups are contiguous, and
// kept content can never absorb a drop.

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

function drop(startMs: number, endMs: number): RawSegmentItem {
  return {
    anchorText: null,
    dropReason: "sponsor",
    endMs,
    hook: null,
    kind: "drop",
    startMs,
    summary: null,
    title: null,
  };
}

function keepGroup(atomIds: string[], title: string) {
  return {
    atomIds,
    dropReason: null,
    hook: `${title} hook`,
    kind: "keep" as const,
    reasoning: "These atoms develop one continuous topic.",
    summary: `${title} summary`,
    title,
  };
}

function dropGroup(atomIds: string[]) {
  return {
    atomIds,
    dropReason: "sponsor" as const,
    hook: null,
    kind: "drop" as const,
    reasoning: "This is one sponsor interruption.",
    summary: null,
    title: null,
  };
}

describe("numberSegmentAtoms", () => {
  it("assigns stable unique IDs without changing the rough plan", () => {
    const items = [keep(0, 1000, "Opening"), drop(1000, 2000)];

    const first = numberSegmentAtoms(items);
    const again = numberSegmentAtoms(items);

    expect(first.map((atom) => atom.atomId)).toEqual(["A000", "A001"]);
    expect(first.map((atom) => atom.atomId)).toEqual(
      again.map((atom) => atom.atomId)
    );
    expect(new Set(first.map((atom) => atom.atomId)).size).toBe(items.length);
    expect(first.map(({ atomId: _atomId, ...item }) => item)).toEqual(items);
  });
});

describe("validateSegmentGrouping", () => {
  it("accepts an exact ordered grouping that keeps every boundary", () => {
    const atoms = numberSegmentAtoms([
      keep(0, 1000, "Opening"),
      keep(1000, 2000, "Middle"),
      keep(2000, 3000, "Closing"),
    ]);
    const groups = atoms.map((atom) =>
      keepGroup([atom.atomId], atom.title ?? "Chapter")
    );

    expect(validateSegmentGrouping(atoms, groups)).toEqual({
      issues: [],
      ok: true,
    });
    expect(applySegmentGrouping(atoms, groups)).toMatchObject({
      issues: [],
      mergedBoundaries: 0,
      status: "applied",
    });
  });

  it("fails closed for omitted, duplicated, reordered, and non-contiguous atoms", () => {
    const items = [
      keep(0, 1000, "One"),
      keep(1000, 2000, "Two"),
      keep(2000, 3000, "Three"),
    ];
    const atoms = numberSegmentAtoms(items);
    const [one, two, three] = atoms;
    expect(one && two && three).toBeTruthy();
    if (!(one && two && three)) {
      return;
    }
    const invalidPlans = [
      // Omitted middle atom.
      [keepGroup([one.atomId], "One"), keepGroup([three.atomId], "Three")],
      // Duplicated first atom.
      [
        keepGroup([one.atomId], "One"),
        keepGroup([one.atomId, two.atomId, three.atomId], "Rest"),
      ],
      // Same inventory, wrong order.
      [keepGroup([two.atomId, one.atomId, three.atomId], "Reordered")],
      // A group jumps over an atom assigned to another group.
      [
        keepGroup([one.atomId, three.atomId], "Non-contiguous"),
        keepGroup([two.atomId], "Two"),
      ],
    ];

    for (const groups of invalidPlans) {
      const validation = validateSegmentGrouping(atoms, groups);
      expect(validation.ok).toBe(false);
      expect(validation.issues.length).toBeGreaterThan(0);

      const applied = applySegmentGrouping(atoms, groups);
      expect(applied.status).toBe("fallback");
      expect(applied.items).toEqual(items);
      expect(applied.mergedBoundaries).toBe(0);
    }
  });

  it("never permits kept chapters and dropped material in one group", () => {
    const atoms = numberSegmentAtoms([
      keep(0, 1000, "Topic before sponsor"),
      drop(1000, 2000),
      keep(2000, 3000, "Topic after sponsor"),
    ]);
    const [before, sponsor, after] = atoms;
    expect(before && sponsor && after).toBeTruthy();
    if (!(before && sponsor && after)) {
      return;
    }

    const mixed = [
      keepGroup([before.atomId, sponsor.atomId], "Bad mixed chapter"),
      keepGroup([after.atomId], "Topic after sponsor"),
    ];
    const wrongKind = [
      dropGroup([before.atomId]),
      dropGroup([sponsor.atomId]),
      keepGroup([after.atomId], "Topic after sponsor"),
    ];

    expect(validateSegmentGrouping(atoms, mixed).ok).toBe(false);
    expect(validateSegmentGrouping(atoms, wrongKind).ok).toBe(false);
  });

  it("keeps each dropped stretch as its own fixed barrier", () => {
    const atoms = numberSegmentAtoms([
      drop(0, 1000),
      { ...drop(1000, 2000), dropReason: "housekeeping" },
    ]);

    const result = applySegmentGrouping(atoms, [
      dropGroup(atoms.map((atom) => atom.atomId)),
    ]);

    expect(result.status).toBe("fallback");
    expect(result.items).toHaveLength(2);
    expect(result.issues).toContain(
      "drop group 0 (A000, A001) must remain a singleton barrier"
    );
  });

  it("does not let the Reconciler rewrite a fixed drop reason", () => {
    const atoms = numberSegmentAtoms([drop(0, 1000)]);
    const [atom] = atoms;
    expect(atom).toBeTruthy();
    if (!atom) {
      return;
    }
    const result = applySegmentGrouping(atoms, [
      { ...dropGroup([atom.atomId]), dropReason: "thin" },
    ]);

    expect(result.status).toBe("fallback");
    expect(result.issues).toContain(
      "drop group 0 (A000) changed its fixed reason"
    );
    expect(result.items[0]?.dropReason).toBe("sponsor");
  });

  it("rejects incomplete keep packaging", () => {
    const atoms = numberSegmentAtoms([
      keep(0, 1000, "One"),
      keep(1000, 2000, "Two"),
    ]);
    const missingTitle = {
      ...keepGroup(
        atoms.map((atom) => atom.atomId),
        "Merged"
      ),
      title: null,
    };

    expect(validateSegmentGrouping(atoms, [missingTitle]).ok).toBe(false);
  });

  it("keeps anchorless chapters topology-valid for later grounding", () => {
    const atoms = numberSegmentAtoms([
      { ...keep(0, 1000, "Question"), anchorText: null },
      { ...keep(1000, 2000, "Answer"), anchorText: null },
    ]);
    const groups = [
      keepGroup(
        atoms.map((atom) => atom.atomId),
        "Question and answer"
      ),
    ];

    expect(validateSegmentGrouping(atoms, groups)).toEqual({
      issues: [],
      ok: true,
    });
    expect(applySegmentGrouping(atoms, groups)).toMatchObject({
      items: [
        {
          anchorText: null,
          endMs: 2000,
          kind: "keep",
          startMs: 0,
        },
      ],
      mergedBoundaries: 1,
      status: "applied",
    });
  });

  it("keeps fallback TOC cardinality when a rough keep is untitled", () => {
    const items = [{ ...keep(0, 1000, "One"), title: null }];
    const atoms = numberSegmentAtoms(items);
    const result = applySegmentGrouping(atoms, []);

    expect(result.status).toBe("fallback");
    expect(result.items).toEqual(items);
    expect(result.tableOfContents).toEqual(["Untitled chapter 1"]);
  });
});

describe("applySegmentGrouping", () => {
  it("removes a Karma-shaped question-to-answer boundary", () => {
    const items = [
      // The question atom has no usable anchor; the merged answer does.
      { ...keep(0, 60_000, "The Three Strands of Karma"), anchorText: null },
      keep(60_000, 131_000, "Why Painful Karma Still Happens"),
      keep(131_000, 300_000, "A Genuinely New Subject"),
    ];
    const atoms = numberSegmentAtoms(items);
    const [question, answer, next] = atoms;
    expect(question && answer && next).toBeTruthy();
    if (!(question && answer && next)) {
      return;
    }
    const result = applySegmentGrouping(atoms, [
      keepGroup(
        [question.atomId, answer.atomId],
        "Why Painful Karma Still Happens"
      ),
      keepGroup([next.atomId], "A Genuinely New Subject"),
    ]);

    expect(result.status).toBe("applied");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      anchorText: "Why Painful Karma Still Happens anchor",
      endMs: 131_000,
      kind: "keep",
      startMs: 0,
      title: "Why Painful Karma Still Happens",
    });
    expect(result.items[1]).toMatchObject({
      endMs: 300_000,
      startMs: 131_000,
    });
    expect(result.mergedBoundaries).toBe(1);
  });

  it("preserves the source anchor when regrouping a singleton", () => {
    const item = keep(0, 1000, "One complete topic");
    const atoms = numberSegmentAtoms([item]);
    const [atom] = atoms;
    expect(atom).toBeTruthy();
    if (!atom) {
      return;
    }

    const result = applySegmentGrouping(atoms, [
      keepGroup([atom.atomId], "One complete topic"),
    ]);

    expect(result.status).toBe("applied");
    expect(result.items[0]?.anchorText).toBe(item.anchorText);
  });

  it("selects an actually grounded constituent anchor for a merge", () => {
    const atoms = numberSegmentAtoms([
      keep(0, 1000, "Question with hallucinated anchor"),
      keep(1000, 2000, "Grounded answer"),
    ]);
    const [question, answer] = atoms;
    expect(question && answer).toBeTruthy();
    if (!(question && answer)) {
      return;
    }

    const result = applySegmentGrouping(
      atoms,
      [keepGroup([question.atomId, answer.atomId], "Question and answer")],
      { groundedAtomIds: new Set([answer.atomId]) }
    );

    expect(result.status).toBe("applied");
    expect(result.items[0]?.anchorText).toBe(answer.anchorText);
  });

  it("derives the final TOC one-to-one from kept groups", () => {
    const atoms = numberSegmentAtoms([
      keep(0, 1000, "Rough title one"),
      drop(1000, 2000),
      keep(2000, 3000, "Rough title two"),
    ]);
    const [first, sponsor, second] = atoms;
    expect(first && sponsor && second).toBeTruthy();
    if (!(first && sponsor && second)) {
      return;
    }

    const result = applySegmentGrouping(atoms, [
      keepGroup([first.atomId], "Final chapter one"),
      dropGroup([sponsor.atomId]),
      keepGroup([second.atomId], "Final chapter two"),
    ]);

    expect(result.tableOfContents).toEqual([
      "Final chapter one",
      "Final chapter two",
    ]);
    expect(result.items.filter((item) => item.kind === "keep")).toHaveLength(
      result.tableOfContents.length
    );
  });

  it("keeps drop boundaries while merging adjacent keep atoms", () => {
    const atoms = numberSegmentAtoms([
      keep(0, 1000, "Question"),
      keep(1000, 2000, "Answer"),
      drop(2000, 3000),
      keep(3000, 4000, "Next question"),
      keep(4000, 5000, "Next answer"),
    ]);
    const ids = atoms.map((atom) => atom.atomId);
    const result = applySegmentGrouping(atoms, [
      keepGroup(ids.slice(0, 2), "Question and answer"),
      dropGroup(ids.slice(2, 3)),
      keepGroup(ids.slice(3), "Next question and answer"),
    ]);

    expect(result.items.map((item) => item.kind)).toEqual([
      "keep",
      "drop",
      "keep",
    ]);
    expect(result.items.map((item) => [item.startMs, item.endMs])).toEqual([
      [0, 2000],
      [2000, 3000],
      [3000, 5000],
    ]);
    expect(result.mergedBoundaries).toBe(2);
  });
});
