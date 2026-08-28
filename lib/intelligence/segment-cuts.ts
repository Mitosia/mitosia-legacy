import type { RawSegmentItem } from "@/lib/ai/capabilities/segment-plan";
import type { CutGrid, CutterWindow } from "./grid";

export interface SegmentCutProposal {
  cutId: number;
  itemIndex: number;
  window: CutterWindow;
}

export interface AppliedSegmentCuts {
  applied: number;
  atomicFallback: boolean;
  items: RawSegmentItem[];
  rejected: number;
}

// Apply parallel Cutter answers only after every answer has returned. Each
// Cutter may select only a sentence it was actually shown, and a refined cut
// may never cross either neighboring rough boundary. The old implementation
// clamped against the whole episode and mutated starts concurrently, which
// allowed a hallucinated ID to reorder chapter identities silently.
export function applySegmentCutProposals(
  sourceItems: readonly RawSegmentItem[],
  grid: CutGrid,
  proposals: readonly SegmentCutProposal[]
): AppliedSegmentCuts {
  const original = [...sourceItems]
    .sort((left, right) => left.startMs - right.startMs)
    .map((item) => ({ ...item }));
  const items = original.map((item) => ({ ...item }));
  const proposalCounts = new Map<number, number>();
  for (const proposal of proposals) {
    proposalCounts.set(
      proposal.itemIndex,
      (proposalCounts.get(proposal.itemIndex) ?? 0) + 1
    );
  }

  let applied = 0;
  let rejected = 0;
  for (const proposal of proposals) {
    const item = items[proposal.itemIndex];
    const sentence = grid.sentences[proposal.cutId];
    const duplicate = (proposalCounts.get(proposal.itemIndex) ?? 0) > 1;
    const inWindow =
      Number.isInteger(proposal.cutId) &&
      proposal.cutId >= proposal.window.fromSentence &&
      proposal.cutId <= proposal.window.toSentence;
    const previous = original[proposal.itemIndex - 1];
    const next = original[proposal.itemIndex + 1];
    const insideNeighborBounds =
      sentence !== undefined &&
      (previous === undefined || sentence.startMs > previous.startMs) &&
      (next === undefined || sentence.startMs < next.startMs);
    if (!(item && sentence && !duplicate && inWindow && insideNeighborBounds)) {
      rejected += 1;
      continue;
    }
    item.startMs = sentence.startMs;
    applied += 1;
  }

  const strictlyOrdered = items.every(
    (item, index) =>
      index === 0 || item.startMs > (items[index - 1]?.startMs ?? 0)
  );
  if (!strictlyOrdered) {
    return {
      applied: 0,
      atomicFallback: true,
      items: original,
      rejected: proposals.length,
    };
  }
  return { applied, atomicFallback: false, items, rejected };
}
