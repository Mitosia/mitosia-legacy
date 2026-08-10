import { eq } from "drizzle-orm";
import { source } from "./db/schema";
import type { OrgTransaction } from "./db/tenant";

// Shared by the per-source upload routes: the row must be visible inside
// the caller's org scope (RLS) and still mid-upload. Returns null for
// anything else — cross-tenant ids are indistinguishable from missing.
export async function loadUploadingSource(tx: OrgTransaction, id: string) {
  const [row] = await tx
    .select({
      id: source.id,
      status: source.status,
      storageKey: source.storageKey,
      uploadId: source.uploadId,
    })
    .from(source)
    .where(eq(source.id, id))
    .limit(1);

  if (row?.status !== "uploading" || !row.uploadId) {
    return null;
  }
  return { id: row.id, storageKey: row.storageKey, uploadId: row.uploadId };
}
