import { sql } from "drizzle-orm";
import { db } from "./index";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OrgTransaction = Transaction;

// All access to tenant-owned tables goes through here. The transaction-local
// app.organization_id setting is what the RLS policies check; without it,
// every tenant table reads as empty and writes are rejected (fail closed).
export function withOrgScope<T>(
  organizationId: string,
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.organization_id', ${organizationId}, true)`
    );
    return await fn(tx);
  });
}
