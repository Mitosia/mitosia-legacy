import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireOrgApi } from "@/lib/api-auth";
import { recordAudit } from "@/lib/audit";
import { source } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { abortMultipartUpload } from "@/lib/storage";
import { loadUploadingSource } from "@/lib/uploads";

// Cancels an in-flight upload: discards the storage-side parts and removes
// the source record (it never became content, so nothing to keep).
export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/uploads/[sourceId]/abort">
) {
  const { sourceId } = await ctx.params;
  const parsedId = z.uuid().safeParse(sourceId);
  if (!parsedId.success) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const authCtx = await requireOrgApi();
  if (authCtx.error) {
    return authCtx.error;
  }
  const { organizationId, userId } = authCtx;

  const upload = await withOrgScope(organizationId, (tx) =>
    loadUploadingSource(tx, parsedId.data)
  );
  if (!upload) {
    // Already completed or never existed — nothing to abort.
    return Response.json({ ok: true });
  }

  try {
    await abortMultipartUpload(upload.storageKey, upload.uploadId);
  } catch {
    // The storage-side upload may already be gone (expired or aborted
    // twice); the record cleanup below is what matters.
  }

  await withOrgScope(organizationId, async (tx) => {
    await tx.delete(source).where(eq(source.id, upload.id));
    await recordAudit(tx, {
      action: "source.upload_aborted",
      actorUserId: userId,
      entityId: upload.id,
      entityType: "source",
      organizationId,
    });
  });

  return Response.json({ ok: true });
}
