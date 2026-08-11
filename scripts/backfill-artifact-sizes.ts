import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization, sourceArtifact, usageLedger } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { headObject, listObjects } from "@/lib/storage";

// One-shot backfill for source_artifact.size_bytes, which the ingest
// pipeline never wrote before this change: every artifact row created up to
// then has a NULL size, so per-artifact cost attribution is blank for them.
// Sizes are read back from object storage — the objects are the source of
// truth, and artifact objects are written once and never mutated in place
// except by a re-ingest (which now writes sizes itself).
//
// Runs through withOrgScope like the app, org by org, so it works under RLS
// with the ordinary unprivileged DATABASE_URL role — no superuser, no
// policy exemption. The organization table is not tenant-scoped, so the org
// list itself is readable without context.
//
// It NEVER touches usage_ledger. That table is append-only by policy shape
// and its existing artifact entries were already metered from real byte
// totals, so they need no correction. Where the freshly summed artifact
// bytes disagree with what the ledger recorded, the script reports the
// drift and leaves the decision (a compensating entry, or nothing) to a
// human — see AGENTS.md.
//
//   pnpm backfill:artifact-sizes [--dry-run]

const DRY_RUN = process.argv.includes("--dry-run");

interface PendingArtifact {
  id: string;
  kind: string;
  sourceId: string;
  storageKey: string;
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

// An hls_master row stands for the whole ladder — every variant playlist
// and segment under hls/ — which is how the pipeline sizes it too. Sizing
// it as just master.m3u8 would make the artifact sum disagree with both the
// bucket and the ledger.
async function resolveSize(artifact: PendingArtifact): Promise<number | null> {
  try {
    if (artifact.kind === "hls_master") {
      const prefix = artifact.storageKey.slice(
        0,
        artifact.storageKey.lastIndexOf("/") + 1
      );
      const objects = await listObjects(prefix);
      if (objects.length === 0) {
        return null;
      }
      return objects.reduce((total, object) => total + object.size, 0);
    }
    return (await headObject(artifact.storageKey)).size;
  } catch {
    // Missing or unreadable object: leave the row NULL and report it
    // rather than writing a wrong number into a billing input.
    return null;
  }
}

async function pendingArtifacts(
  organizationId: string
): Promise<PendingArtifact[]> {
  return await withOrgScope(organizationId, (tx) =>
    tx
      .select({
        id: sourceArtifact.id,
        kind: sourceArtifact.kind,
        sourceId: sourceArtifact.sourceId,
        storageKey: sourceArtifact.storageKey,
      })
      .from(sourceArtifact)
      .where(isNull(sourceArtifact.sizeBytes))
  );
}

// Post-backfill reconciliation: the summed artifact rows against what the
// ledger already recorded for this source's artifacts. Reported only.
async function reportDrift(
  organizationId: string,
  sourceIds: string[]
): Promise<void> {
  for (const sourceId of sourceIds) {
    // biome-ignore lint/performance/noAwaitInLoops: one small query per touched source
    const drift = await withOrgScope(organizationId, async (tx) => {
      const [artifacts] = await tx
        .select({
          total: sql<number>`COALESCE(SUM(${sourceArtifact.sizeBytes}), 0)::double precision`,
          unsized: sql<number>`COUNT(*) FILTER (WHERE ${sourceArtifact.sizeBytes} IS NULL)::int`,
        })
        .from(sourceArtifact)
        .where(eq(sourceArtifact.sourceId, sourceId));

      const [ledger] = await tx
        .select({
          total: sql<number>`COALESCE(SUM(${usageLedger.quantity}), 0)`,
        })
        .from(usageLedger)
        .where(
          sql`${usageLedger.sourceId} = ${sourceId}
            AND ${usageLedger.entryType} = 'storage_bytes'
            AND ${usageLedger.metadata}->>'category' = 'artifacts'`
        );

      return {
        artifacts: artifacts?.total ?? 0,
        ledger: ledger?.total ?? 0,
        unsized: artifacts?.unsized ?? 0,
      };
    });

    if (drift.unsized > 0) {
      write(
        `  source ${sourceId}: ${drift.unsized} artifact(s) still unsized — sum is incomplete, skipping drift check`
      );
      continue;
    }
    if (drift.artifacts !== drift.ledger) {
      write(
        `  source ${sourceId}: DRIFT artifacts=${drift.artifacts} ledger=${drift.ledger} (delta ${drift.artifacts - drift.ledger}) — no ledger entry written`
      );
    }
  }
}

async function backfillOrg(organizationId: string): Promise<{
  failed: number;
  updated: number;
}> {
  const pending = await pendingArtifacts(organizationId);
  if (pending.length === 0) {
    return { failed: 0, updated: 0 };
  }

  write(`org ${organizationId}: ${pending.length} artifact(s) without a size`);

  // Sizes are resolved outside the transaction: holding one open across a
  // few hundred round trips to object storage is a needless lock.
  const sized: { id: string; sizeBytes: number }[] = [];
  let failed = 0;
  for (const artifact of pending) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential keeps storage request rates polite
    const sizeBytes = await resolveSize(artifact);
    if (sizeBytes === null) {
      failed += 1;
      write(`  no object for ${artifact.storageKey} — left NULL`);
      continue;
    }
    sized.push({ id: artifact.id, sizeBytes });
  }

  if (DRY_RUN) {
    write(`  would update ${sized.length} row(s) (dry run)`);
    return { failed, updated: 0 };
  }

  await withOrgScope(organizationId, async (tx) => {
    for (const row of sized) {
      // biome-ignore lint/performance/noAwaitInLoops: one narrow update per row, inside one transaction
      await tx
        .update(sourceArtifact)
        .set({ sizeBytes: row.sizeBytes })
        .where(
          and(eq(sourceArtifact.id, row.id), isNull(sourceArtifact.sizeBytes))
        );
    }
  });

  await reportDrift(organizationId, [
    ...new Set(pending.map((artifact) => artifact.sourceId)),
  ]);

  return { failed, updated: sized.length };
}

async function main() {
  const orgs = await db.select({ id: organization.id }).from(organization);
  write(
    `${DRY_RUN ? "[dry run] " : ""}scanning ${orgs.length} organization(s)`
  );

  let failed = 0;
  let updated = 0;
  for (const org of orgs) {
    // biome-ignore lint/performance/noAwaitInLoops: one org at a time keeps the output readable
    const result = await backfillOrg(org.id);
    failed += result.failed;
    updated += result.updated;
  }

  write(`done: ${updated} row(s) sized, ${failed} unresolved`);
  // The db module owns a long-lived pool; nothing else keeps this alive.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`backfill failed: ${error}\n`);
  process.exit(1);
});
