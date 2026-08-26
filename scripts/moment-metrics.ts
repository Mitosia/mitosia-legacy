import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  momentCandidate,
  organization,
  segmentClip,
  source,
} from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { tuneOutboundConnections } from "@/lib/net-tuning";

// The Gate M1 readout (S6 §7): the two north-star quality metrics as plain
// SQL over moment_candidate, printed per source and overall.
//
// - Acceptance rate = accepted / (accepted + rejected), over grounded,
//   non-suppressed candidates. Shortlisted/proposed rows are undecided and
//   count toward neither side.
// - Boundary adjustment = |adjusted − snapped| per side over ACCEPTED
//   candidates, null adjusted = 0 (an untouched boundary was a correct
//   boundary). Mean and median both print; the M1 working definition is
//   median ≤ ~3s per side.
//
// Runs through withOrgScope like the app — works under RLS with the
// ordinary unprivileged DATABASE_URL role.
//
//   pnpm moments:metrics

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface CandidateRow {
  adjustedEndMs: number | null;
  adjustedStartMs: number | null;
  endMs: number;
  sourceId: string;
  sourceTitle: string;
  startMs: number;
  status: string;
}

function median(values: readonly number[]): number {
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

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

interface Metrics {
  accepted: number;
  deltasIn: number[];
  deltasOut: number[];
  proposed: number;
  rejected: number;
  shortlisted: number;
  total: number;
}

function emptyMetrics(): Metrics {
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

function accumulate(metrics: Metrics, row: CandidateRow): void {
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

function report(label: string, metrics: Metrics): void {
  const decided = metrics.accepted + metrics.rejected;
  const acceptance =
    decided === 0
      ? "no decisions yet"
      : `${metrics.accepted}/${decided} (${((metrics.accepted / decided) * 100).toFixed(0)}%)`;
  write(`${label}`);
  write(
    `  candidates: ${metrics.total} — ${metrics.accepted} accepted · ${metrics.shortlisted} shortlisted · ${metrics.rejected} rejected · ${metrics.proposed} undecided`
  );
  write(`  acceptance rate: ${acceptance}`);
  if (metrics.accepted > 0) {
    write(
      `  boundary Δ (accepted) — in: mean ${seconds(mean(metrics.deltasIn))}, median ${seconds(median(metrics.deltasIn))} · out: mean ${seconds(mean(metrics.deltasOut))}, median ${seconds(median(metrics.deltasOut))}`
    );
  }
}

async function orgCandidates(organizationId: string): Promise<CandidateRow[]> {
  return await withOrgScope(organizationId, (tx) =>
    tx
      .select({
        adjustedEndMs: momentCandidate.adjustedEndMs,
        adjustedStartMs: momentCandidate.adjustedStartMs,
        endMs: momentCandidate.endMs,
        sourceId: momentCandidate.sourceId,
        sourceTitle: source.title,
        startMs: momentCandidate.startMs,
        status: momentCandidate.status,
      })
      .from(momentCandidate)
      .innerJoin(source, eq(momentCandidate.sourceId, source.id))
      .where(
        and(
          eq(momentCandidate.grounded, true),
          eq(momentCandidate.suppressed, false)
        )
      )
      .orderBy(source.title, momentCandidate.rank)
  );
}

async function orgSegments(organizationId: string): Promise<CandidateRow[]> {
  return await withOrgScope(organizationId, (tx) =>
    tx
      .select({
        adjustedEndMs: segmentClip.adjustedEndMs,
        adjustedStartMs: segmentClip.adjustedStartMs,
        endMs: segmentClip.endMs,
        sourceId: segmentClip.sourceId,
        sourceTitle: source.title,
        startMs: segmentClip.startMs,
        status: segmentClip.status,
      })
      .from(segmentClip)
      .innerJoin(source, eq(segmentClip.sourceId, source.id))
      .where(eq(segmentClip.kind, "keep"))
      .orderBy(source.title, segmentClip.idx)
  );
}

function reportGroup(label: string, rows: CandidateRow[], overall: Metrics) {
  if (rows.length === 0) {
    return;
  }
  write(label);
  const bySource = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const list = bySource.get(row.sourceId) ?? [];
    list.push(row);
    bySource.set(row.sourceId, list);
  }
  for (const [sourceId, sourceRows] of bySource) {
    const metrics = emptyMetrics();
    for (const row of sourceRows) {
      accumulate(metrics, row);
      accumulate(overall, row);
    }
    report(`${sourceRows[0]?.sourceTitle ?? sourceId} (${sourceId})`, metrics);
  }
}

async function main() {
  tuneOutboundConnections();
  const orgs = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization);

  const overall = emptyMetrics();
  const overallSegments = emptyMetrics();
  for (const org of orgs) {
    // biome-ignore lint/performance/noAwaitInLoops: one org at a time keeps the output readable
    const [rows, segmentRows] = await Promise.all([
      orgCandidates(org.id),
      orgSegments(org.id),
    ]);
    if (rows.length === 0 && segmentRows.length === 0) {
      continue;
    }
    reportGroup(`── ${org.name} · moments`, rows, overall);
    reportGroup(
      `── ${org.name} · segment clips (keeps)`,
      segmentRows,
      overallSegments
    );
  }

  if (overall.total === 0 && overallSegments.total === 0) {
    write("no clip candidates anywhere yet");
  }
  if (overall.total > 0) {
    write("── OVERALL · moments");
    report("all sources", overall);
  }
  if (overallSegments.total > 0) {
    write("── OVERALL · segment clips");
    report("all sources", overallSegments);
  }
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`moment metrics failed: ${error}\n`);
  process.exit(1);
});
