import { describe, expect, it } from "vitest";
import {
  isSegmentBoundaryRefinable,
  segmentBoundaryGuidance,
} from "@/lib/ai/capabilities/clip-fine-cut";

describe("segment Cutter boundary semantics", () => {
  it("places KEEP→DROP after the payoff at the first discarded sentence", () => {
    expect(
      segmentBoundaryGuidance({
        afterDropReason: "sponsor",
        afterKind: "drop",
        beforeDropReason: null,
        beforeKind: "keep",
      })
    ).toContain(
      "choose the first sentence of the discarded sponsor material, only after the kept chapter's payoff has fully landed"
    );
  });

  it("places DROP→KEEP at the kept chapter setup", () => {
    expect(
      segmentBoundaryGuidance({
        afterDropReason: null,
        afterKind: "keep",
        beforeDropReason: "housekeeping",
        beforeKind: "drop",
      })
    ).toContain(
      "exclude all housekeeping material and choose the kept chapter's first self-contained question or setup sentence"
    );
  });

  it("places KEEP→KEEP only at a genuine topic turn", () => {
    expect(
      segmentBoundaryGuidance({
        afterDropReason: null,
        afterKind: "keep",
        beforeDropReason: null,
        beforeKind: "keep",
      })
    ).toContain("at a genuine topic turn");
  });

  it("does not send DROP→DROP boundaries to the Cutter", () => {
    expect(isSegmentBoundaryRefinable("drop", "drop")).toBe(false);
    expect(isSegmentBoundaryRefinable("drop", "keep")).toBe(true);
    expect(() =>
      segmentBoundaryGuidance({
        afterDropReason: "sponsor",
        afterKind: "drop",
        beforeDropReason: "housekeeping",
        beforeKind: "drop",
      })
    ).toThrow("DROP→DROP boundaries are not Cutter targets");
  });
});
