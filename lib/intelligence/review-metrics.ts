// The Gate M1 readout's pure half: acceptance rate and boundary-adjustment
// magnitude over reviewed clip rows (S6 §7). Extracted from
// scripts/moment-metrics.ts so the Python pipeline's eval runner can port
// these exact semantics and hold parity against them (pipeline A1); the
// script keeps the SQL and rendering loop, this module owns the math and
// the report text.

export interface ReviewedClipRow {
  adjustedEndMs: number | null;
  adjustedStartMs: number | null;
  endMs: number;
  startMs: number;
  status: string;
}

export interface ReviewMetrics {
  accepted: number;
  deltasIn: number[];
  deltasOut: number[];
  proposed: number;
  rejected: number;
  shortlisted: number;
  total: number;
}

export function emptyReviewMetrics(): ReviewMetrics {
  return {
    accepted: 0,
    deltasIn: [],
    deltasOut: [],
    proposed: 0,
    rejected: 0,
    shortlisted: 0,
    total: 0,
  };
}

export function accumulateReviewMetrics(
  metrics: ReviewMetrics,
  row: ReviewedClipRow
): void {
  metrics.total += 1;
  if (row.status === "accepted") {
    metrics.accepted += 1;
    metrics.deltasIn.push(
      Math.abs((row.adjustedStartMs ?? row.startMs) - row.startMs)
    );
    metrics.deltasOut.push(
      Math.abs((row.adjustedEndMs ?? row.endMs) - row.endMs)
    );
  } else if (row.status === "rejected") {
    metrics.rejected += 1;
  } else if (row.status === "shortlisted") {
    metrics.shortlisted += 1;
  } else {
    metrics.proposed += 1;
  }
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) {
    return upper;
  }
  return ((sorted[middle - 1] ?? 0) + upper) / 2;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function reviewMetricsLines(
  label: string,
  metrics: ReviewMetrics
): string[] {
  const decided = metrics.accepted + metrics.rejected;
  const acceptance =
    decided === 0
      ? "no decisions yet"
      : `${metrics.accepted}/${decided} (${((metrics.accepted / decided) * 100).toFixed(0)}%)`;
  const lines = [
    `${label}`,
    `  candidates: ${metrics.total} — ${metrics.accepted} accepted · ${metrics.shortlisted} shortlisted · ${metrics.rejected} rejected · ${metrics.proposed} undecided`,
    `  acceptance rate: ${acceptance}`,
  ];
  if (metrics.accepted > 0) {
    lines.push(
      `  boundary Δ (accepted) — in: mean ${seconds(mean(metrics.deltasIn))}, median ${seconds(median(metrics.deltasIn))} · out: mean ${seconds(mean(metrics.deltasOut))}, median ${seconds(median(metrics.deltasOut))}`
    );
  }
  return lines;
}
