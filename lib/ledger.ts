import { usageLedger } from "./db/schema";
import type { OrgTransaction } from "./db/tenant";

interface UsageEntry {
  correlationId: string;
  entryType: "storage_bytes" | "processing_minutes";
  metadata?: Record<string, unknown>;
  organizationId: string;
  quantity: number;
  sourceId?: string;
  unit: "bytes" | "minutes";
}

// Append-only usage metering. correlation_id carries a unique index and
// conflicts are swallowed, so callers can safely re-run (retried uploads,
// re-enqueued pipeline steps) without double-charging. Corrections are
// compensating entries with negative quantities, never edits — the table
// has no UPDATE/DELETE policies (see 0003 migration).
export async function recordUsage(
  tx: OrgTransaction,
  entry: UsageEntry
): Promise<void> {
  await tx
    .insert(usageLedger)
    .values(entry)
    .onConflictDoNothing({ target: usageLedger.correlationId });
}
