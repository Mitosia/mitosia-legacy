import { auditLog } from "./db/schema";
import type { OrgTransaction } from "./db/tenant";

interface AuditEntry {
  action: string;
  actorUserId: string;
  entityId?: string;
  entityType: string;
  metadata?: Record<string, unknown>;
  organizationId: string;
}

// Append-only. Written inside the same withOrgScope transaction as the
// mutation it records, so an audit row exists iff the change committed.
export function recordAudit(tx: OrgTransaction, entry: AuditEntry) {
  return tx.insert(auditLog).values(entry);
}
