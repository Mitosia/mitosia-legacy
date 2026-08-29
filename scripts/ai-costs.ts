import { and, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization, usageLedger } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { tuneOutboundConnections } from "@/lib/net-tuning";

// The AI spend readout (2026-08-30, born from the $6 brief-validator
// incident): every tuning decision about model routing must be an argument
// over ledger facts, not vibes. Prints, per organization, the last N days of
// `ai_tokens` entries grouped by task and by model — billed cost (OpenRouter's
// reported per-request cost, summed at write time), token volume, cache-read
// share, attempts-per-call amplification, and spend on failed runs — plus the
// most expensive individual runs with their $/source-hour.
//
// Runs through withOrgScope like the app, so the ordinary unprivileged
// DATABASE_URL role works and RLS applies.
//
//   pnpm ai:costs             # last 30 days
//   pnpm ai:costs -- --days 7
//
// Reading it: `attempts` far above `calls` means retries/failover are
// amplifying spend (the incident signature). A low cache-read share on tasks
// documented as sharing a cached prefix means the cache assumption is not
// holding (measured 22.5% on 2026-08-30) — treat it as a fact to design
// against, never assume reuse.

const DAYS_FLAG = process.argv.indexOf("--days");
const DAYS = DAYS_FLAG > -1 ? Number(process.argv[DAYS_FLAG + 1]) || 30 : 30;
const TOP_RUNS = 10;

interface EntryMetadata {
  attempts?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  calls?: number;
  costUsd?: number | null;
  failed?: boolean;
  inputTokens?: number;
  // Embedding entries label themselves with `kind: "embedding"` instead of
  // a task id (lib/intelligence metering predates the task registry).
  kind?: string;
  model?: string;
  outputTokens?: number;
  sourceHours?: number;
  task?: string;
}

interface Bucket {
  attempts: number;
  cacheReadTokens: number;
  calls: number;
  costKnown: boolean;
  costUsd: number;
  entries: number;
  failedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

function emptyBucket(): Bucket {
  return {
    attempts: 0,
    cacheReadTokens: 0,
    calls: 0,
    costKnown: true,
    costUsd: 0,
    entries: 0,
    failedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function accumulate(bucket: Bucket, meta: EntryMetadata): void {
  bucket.entries += 1;
  bucket.calls += meta.calls ?? 1;
  bucket.attempts += meta.attempts ?? 0;
  bucket.inputTokens += meta.inputTokens ?? 0;
  bucket.outputTokens += meta.outputTokens ?? 0;
  bucket.cacheReadTokens += meta.cacheReadTokens ?? 0;
  if (typeof meta.costUsd === "number") {
    bucket.costUsd += meta.costUsd;
    if (meta.failed) {
      bucket.failedCostUsd += meta.costUsd;
    }
  } else {
    bucket.costKnown = false;
  }
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function money(value: number, known: boolean): string {
  return `$${value.toFixed(3)}${known ? "" : "+?"}`;
}

// `segment:{sourceId}:{attempt}:brief` → `segment:{sourceId}:{attempt}`;
// standalone correlations (searches, q&a) group as themselves.
const RUN_KEY_PATTERN =
  /^((?:segment|discover|extract|transcription|analysis|index):[0-9a-f-]{36}:\d+)/u;

function runKeyOf(correlationId: string): string {
  return correlationId.match(RUN_KEY_PATTERN)?.[1] ?? correlationId;
}

interface LedgerRow {
  correlationId: string;
  createdAt: Date;
  metadata: unknown;
}

interface RunTotals {
  costUsd: number;
  sourceHours: number;
}

interface OrgAggregate {
  byModel: Map<string, Bucket>;
  byRun: Map<string, RunTotals>;
  byTask: Map<string, Bucket>;
}

function aggregateRows(rows: readonly LedgerRow[]): OrgAggregate {
  const byTask = new Map<string, Bucket>();
  const byModel = new Map<string, Bucket>();
  const byRun = new Map<string, RunTotals>();
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as EntryMetadata;
    const task = meta.task ?? meta.kind ?? "unknown";
    const taskBucket = byTask.get(task) ?? emptyBucket();
    accumulate(taskBucket, meta);
    byTask.set(task, taskBucket);
    const modelBucket = byModel.get(meta.model ?? "unknown") ?? emptyBucket();
    accumulate(modelBucket, meta);
    byModel.set(meta.model ?? "unknown", modelBucket);

    const runKey = runKeyOf(row.correlationId);
    const run = byRun.get(runKey) ?? { costUsd: 0, sourceHours: 0 };
    run.costUsd += typeof meta.costUsd === "number" ? meta.costUsd : 0;
    run.sourceHours = Math.max(run.sourceHours, meta.sourceHours ?? 0);
    byRun.set(runKey, run);
  }
  return { byModel, byRun, byTask };
}

function descendingByCost<T extends { costUsd: number }>(
  entries: Iterable<[string, T]>
): [string, T][] {
  return [...entries].sort((a, b) => b[1].costUsd - a[1].costUsd);
}

function printTaskTable(byTask: OrgAggregate["byTask"]): void {
  write(
    "   task                              calls attempt    in-tok   out-tok cache-hit    cost   failed$"
  );
  for (const [task, bucket] of descendingByCost(byTask.entries())) {
    const cacheShare =
      bucket.inputTokens > 0
        ? `${((100 * bucket.cacheReadTokens) / bucket.inputTokens).toFixed(0)}%`
        : "-";
    write(
      `   ${task.padEnd(33)} ${String(bucket.calls).padStart(5)} ${String(bucket.attempts).padStart(7)} ${String(bucket.inputTokens).padStart(9)} ${String(bucket.outputTokens).padStart(9)} ${cacheShare.padStart(9)} ${money(bucket.costUsd, bucket.costKnown).padStart(9)} ${money(bucket.failedCostUsd, true).padStart(9)}`
    );
  }
}

function printOrgReport(aggregate: OrgAggregate): void {
  printTaskTable(aggregate.byTask);
  write("   models:");
  for (const [model, bucket] of descendingByCost(aggregate.byModel.entries())) {
    write(
      `     ${model.padEnd(38)} ${money(bucket.costUsd, bucket.costKnown).padStart(9)}  (${bucket.attempts} attempts)`
    );
  }
  write(`   most expensive runs (top ${TOP_RUNS}):`);
  for (const [runKey, run] of descendingByCost(aggregate.byRun.entries()).slice(
    0,
    TOP_RUNS
  )) {
    const perHour =
      run.sourceHours > 0
        ? ` — $${(run.costUsd / run.sourceHours).toFixed(2)}/source-hour`
        : "";
    write(`     ${runKey.padEnd(60)} $${run.costUsd.toFixed(3)}${perHour}`);
  }
}

async function loadOrgRows(orgId: string, cutoff: Date): Promise<LedgerRow[]> {
  return await withOrgScope(orgId, (tx) =>
    tx
      .select({
        correlationId: usageLedger.correlationId,
        createdAt: usageLedger.createdAt,
        metadata: usageLedger.metadata,
      })
      .from(usageLedger)
      .where(
        and(
          eq(usageLedger.organizationId, orgId),
          eq(usageLedger.entryType, "ai_tokens"),
          gte(usageLedger.createdAt, cutoff)
        )
      )
  );
}

async function main(): Promise<void> {
  tuneOutboundConnections();
  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const orgs = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization);

  let grandCost = 0;
  let grandKnown = true;
  for (const org of orgs) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential per-org report
    const rows = await loadOrgRows(org.id, cutoff);
    if (rows.length === 0) {
      continue;
    }
    const aggregate = aggregateRows(rows);
    write(`\n━━ ${org.name} — last ${DAYS}d, ${rows.length} ledger entries`);
    printOrgReport(aggregate);
    for (const bucket of aggregate.byTask.values()) {
      grandCost += bucket.costUsd;
      grandKnown = grandKnown && bucket.costKnown;
    }
  }
  write(
    `\nTOTAL known billed AI cost, all orgs, last ${DAYS}d: ${money(grandCost, grandKnown)}`
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("[ai-costs] failed:", error);
  process.exit(1);
});
