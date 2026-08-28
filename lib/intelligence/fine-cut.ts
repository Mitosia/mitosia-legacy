import type { MomentFineCut } from "@/lib/ai/capabilities/clip-fine-cut";
import {
  type CutGrid,
  captureLeadInTwoTurn,
  leadOutTrim,
  pauseAirExtend,
  resolveSpan,
  shotSnap,
  staleOpenFlag,
} from "./grid";
import type { tokenizeWords } from "./grounding";
import { groundMomentAnchor, type MomentRow, type MsRange } from "./moments";

// Applying one Cutter verdict to one moment row (docs/clip-cut-architecture
// §4 Pass 4): resolve the selected sentence IDs, run the deterministic
// narrative backstops behind the model's judgment, re-ground the anchor
// inside the refined span (the provenance gate re-proves itself — a fine
// cut that excludes the anchor un-grounds the clip), and record every
// flag. Pure; the pipeline owns the model call and the ordering.

// The complete backstop chain, shared by the first cut and the revision
// re-cut: lead-in capture → lead-out trim → stale-open flag → pause air →
// shot snap. Lead-in is SINGLE-SHOT per row: once a setup has been
// captured, a later application (the revision re-cut) must not walk one
// more turn back from the captured start — that compounding is exactly
// how spans swallow unrelated material.
export function runBackstops(
  range: MsRange,
  grid: CutGrid,
  shotTimesMs: readonly number[],
  options: { skipLeadIn?: boolean } = {}
): { flags: string[]; range: MsRange } {
  const flags: string[] = [];
  const leadIn = options.skipLeadIn
    ? { flags: [] as string[], range }
    : captureLeadInTwoTurn(range, grid);
  flags.push(...leadIn.flags);
  const leadOut = leadOutTrim(leadIn.range, grid);
  flags.push(...leadOut.flags);
  if (staleOpenFlag(leadOut.range, grid)) {
    flags.push("stale_open");
  }
  const aired = pauseAirExtend(leadOut.range, grid);
  const snapped = shotSnap(aired, grid, shotTimesMs);
  flags.push(...snapped.flags);
  return { flags, range: snapped.range };
}

function withFlags(row: MomentRow, flags: readonly string[]): MomentRow {
  const merged = [...row.flags];
  for (const flag of flags) {
    if (!merged.includes(flag)) {
      merged.push(flag);
    }
  }
  return { ...row, flags: merged };
}

// A Cutter failure (or escape hatch) leaves the coarse bounds standing —
// flagged, never fatal (the Reviewer's never-fails-the-run contract).
export function applyMomentFineCut(
  row: MomentRow,
  cut: MomentFineCut | null,
  grid: CutGrid,
  shotTimesMs: readonly number[],
  tokens: ReturnType<typeof tokenizeWords>
): MomentRow {
  if (!cut) {
    return withFlags(row, ["unrefined"]);
  }
  if (
    cut.couldNotFind ||
    cut.inId === null ||
    cut.outId === null ||
    cut.payoffId === null
  ) {
    return withFlags(row, ["no_single_payoff"]);
  }
  // The payoff invariant (§5): the model must LOCATE the payoff inside
  // the clip — in ≤ payoff ≤ out — or the cut is rejected outright and
  // the coarse bounds stand, flagged.
  if (cut.payoffId < cut.inId || cut.payoffId > cut.outId) {
    return withFlags(row, ["payoff_invariant"]);
  }
  const resolved = resolveSpan(grid, cut.inId, cut.outId);
  const flags: string[] = resolved.clamped ? ["id_clamped"] : [];
  if (resolved.endMs <= resolved.startMs) {
    return withFlags(row, [...flags, "unrefined"]);
  }

  const backstopped = runBackstops(resolved, grid, shotTimesMs, {
    skipLeadIn: row.flags.includes("lead_in_captured"),
  });
  flags.push(...backstopped.flags);

  const anchor = groundMomentAnchor(row.anchorText, backstopped.range, tokens);
  const next = withFlags(
    {
      ...row,
      endMs: backstopped.range.endMs,
      grounded:
        anchor.grounded && backstopped.range.endMs > backstopped.range.startMs,
      groundingScore: anchor.score,
      startMs: backstopped.range.startMs,
    },
    flags
  );
  // A fine cut that un-grounds the clip is worse than the coarse cut it
  // replaced: keep the coarse bounds (still grounded) and surface what
  // happened instead of hiding the row.
  if (!next.grounded && row.grounded) {
    return withFlags(row, [...flags, "refine_ungrounded"]);
  }
  return next;
}
