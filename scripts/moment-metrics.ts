import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  momentCandidate,
  organization,
  segmentClip,
  source,
  transcriptChunk,
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
//
// --detail additionally prints, per candidate: status + reject reason,
// reviewer verdict, how far snapping moved the model's raw claim, the
// human's nudges, and the transcript text each clip opens on and closes
// on (approximated from transcript_chunk — good enough to see whether a
// boundary lands on a setup or mid-thought). This is the evidence view
// the boundary post-mortems read; the summary above stays the metric.

const DETAIL = process.argv.includes("--detail");

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

interface DetailRow {
  adjustedEndMs: number | null;
  adjustedStartMs: number | null;
  endMs: number;
  hook: string | null;
  kind: string | null;
  rank: number;
  rawEndMs: number | null;
  rawStartMs: number | null;
  rejectReason: string | null;
  reviewFix: string | null;
  sourceId: string;
  startMs: number;
  status: string;
  title: string | null;
}

interface ChunkRow {
  endMs: number;
  startMs: number;
  text: string;
}

function timestampMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const secs = (ms / 1000 - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${secs}`;
}

// Approximate the transcript text at a boundary from the chunk covering
// it: position within the chunk maps proportionally to a char offset.
// Crude, but a human reading the output can tell a sentence start from a
// mid-thought — which is the question.
function boundaryText(
  chunks: ChunkRow[],
  ms: number,
  side: "closes" | "opens"
): string {
  const chunk =
    chunks.find((c) => ms >= c.startMs && ms < c.endMs) ??
    (side === "opens" ? chunks.find((c) => c.startMs >= ms) : chunks.at(-1));
  if (!chunk) {
    return "(no chunk)";
  }
  const span = Math.max(1, chunk.endMs - chunk.startMs);
  const offset = Math.round(
    (Math.min(Math.max(ms - chunk.startMs, 0), span) / span) * chunk.text.length
  );
  const text =
    side === "opens"
      ? chunk.text.slice(offset, offset + 160)
      : chunk.text.slice(Math.max(0, offset - 160), offset);
  const squashed = text.replace(/\s+/g, " ").trim();
  return side === "opens" ? `${squashed}…` : `…${squashed}`;
}

function deltaLabel(from: number | null, to: number): string {
  if (from === null || from === to) {
    return "0";
  }
  return `${((from - to) / 1000).toFixed(1)}s`;
}

function detailLine(row: DetailRow, chunks: ChunkRow[]): void {
  const inMs = row.adjustedStartMs ?? row.startMs;
  const outMs = row.adjustedEndMs ?? row.endMs;
  const statusLabel = row.rejectReason
    ? `${row.status}(${row.rejectReason})`
    : row.status;
  const review =
    row.reviewFix && row.reviewFix !== "none"
      ? ` [reviewer: ${row.reviewFix}]`
      : "";
  const snapIn =
    row.rawStartMs === null ? "" : deltaLabel(row.rawStartMs, row.startMs);
  const snapOut =
    row.rawEndMs === null ? "" : deltaLabel(row.rawEndMs, row.endMs);
  const nudges =
    row.adjustedStartMs !== null || row.adjustedEndMs !== null
      ? ` · nudged in ${deltaLabel(row.adjustedStartMs, row.startMs)}/out ${deltaLabel(row.adjustedEndMs, row.endMs)}`
      : "";
  const kindLabel = row.kind ? `${row.kind} ` : "";
  write(
    `  #${row.rank + 1} ${kindLabel}${statusLabel} · ${timestampMs(inMs)}–${timestampMs(outMs)} (${((outMs - inMs) / 1000).toFixed(0)}s) · raw→snap in ${snapIn}/out ${snapOut}${nudges}${review}`
  );
  write(
    `     "${row.title ?? "(untitled)"}"${row.hook ? ` — ${row.hook}` : ""}`
  );
  write(`     opens⟶ ${boundaryText(chunks, inMs, "opens")}`);
  write(`     closes⟵ ${boundaryText(chunks, outMs, "closes")}`);
}

async function sourceChunks(
  organizationId: string,
  sourceId: string
): Promise<ChunkRow[]> {
  return await withOrgScope(organizationId, (tx) =>
    tx
      .select({
        endMs: transcriptChunk.endMs,
        startMs: transcriptChunk.startMs,
        text: transcriptChunk.text,
      })
      .from(transcriptChunk)
      .where(eq(transcriptChunk.sourceId, sourceId))
      .orderBy(transcriptChunk.idx)
  );
}

async function detailMoments(organizationId: string): Promise<DetailRow[]> {
  return await withOrgScope(organizationId, (tx) =>
    tx
      .select({
        adjustedEndMs: momentCandidate.adjustedEndMs,
        adjustedStartMs: momentCandidate.adjustedStartMs,
        endMs: momentCandidate.endMs,
        hook: momentCandidate.hook,
        kind: sql<string | null>`NULL`,
        rank: momentCandidate.rank,
        rawEndMs: momentCandidate.rawEndMs,
        rawStartMs: momentCandidate.rawStartMs,
        rejectReason: momentCandidate.rejectReason,
        reviewFix: momentCandidate.reviewFix,
        sourceId: momentCandidate.sourceId,
        startMs: momentCandidate.startMs,
        status: momentCandidate.status,
        title: momentCandidate.title,
      })
      .from(momentCandidate)
      .where(
        and(
          eq(momentCandidate.grounded, true),
          eq(momentCandidate.suppressed, false)
        )
      )
      .orderBy(momentCandidate.sourceId, momentCandidate.rank)
  );
}

async function detailSegments(organizationId: string): Promise<DetailRow[]> {
  return await withOrgScope(organizationId, (tx) =>
    tx
      .select({
        adjustedEndMs: segmentClip.adjustedEndMs,
        adjustedStartMs: segmentClip.adjustedStartMs,
        endMs: segmentClip.endMs,
        hook: segmentClip.hook,
        kind: segmentClip.kind,
        rank: segmentClip.idx,
        rawEndMs: sql<number | null>`NULL`,
        rawStartMs: sql<number | null>`NULL`,
        rejectReason: segmentClip.rejectReason,
        reviewFix: segmentClip.reviewFix,
        sourceId: segmentClip.sourceId,
        startMs: segmentClip.startMs,
        status: segmentClip.status,
        title: segmentClip.title,
      })
      .from(segmentClip)
      .orderBy(segmentClip.sourceId, segmentClip.idx)
  );
}

async function reportDetail(
  organizationId: string,
  label: string,
  rows: DetailRow[]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  write(label);
  const reasons = new Map<string, number>();
  for (const row of rows) {
    if (row.rejectReason) {
      reasons.set(row.rejectReason, (reasons.get(row.rejectReason) ?? 0) + 1);
    }
  }
  if (reasons.size > 0) {
    write(
      `  reject reasons: ${[...reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason} ×${count}`)
        .join(" · ")}`
    );
  }
  const bySource = new Map<string, DetailRow[]>();
  for (const row of rows) {
    const list = bySource.get(row.sourceId) ?? [];
    list.push(row);
    bySource.set(row.sourceId, list);
  }
  for (const [sourceId, sourceRows] of bySource) {
    // biome-ignore lint/performance/noAwaitInLoops: one source at a time keeps the output readable
    const chunks = await sourceChunks(organizationId, sourceId);
    write(`  ── source ${sourceId}`);
    for (const row of sourceRows) {
      detailLine(row, chunks);
    }
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
    if (DETAIL) {
      await reportDetail(
        org.id,
        `── ${org.name} · moments detail`,
        await detailMoments(org.id)
      );
      await reportDetail(
        org.id,
        `── ${org.name} · segments detail`,
        await detailSegments(org.id)
      );
    }
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
