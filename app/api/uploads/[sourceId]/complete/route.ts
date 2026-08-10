import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireOrgApi } from "@/lib/api-auth";
import { recordAudit } from "@/lib/audit";
import { source } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { enqueueIngest } from "@/lib/ingest";
import { recordUsage } from "@/lib/ledger";
import { completeMultipartUpload, headObject } from "@/lib/storage";
import { loadUploadingSource } from "@/lib/uploads";

const completeSchema = z.object({
  parts: z
    .array(
      z.object({
        etag: z.string().min(1),
        partNumber: z.number().int().min(1).max(10_000),
      })
    )
    .min(1),
});

// Finishes the multipart upload: assembles the object, moves the source to
// "uploaded", meters the stored bytes, and kicks off the ingest pipeline.
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/uploads/[sourceId]/complete">
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

  const parsed = completeSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: "Invalid parts payload" }, { status: 400 });
  }

  const upload = await withOrgScope(organizationId, (tx) =>
    loadUploadingSource(tx, parsedId.data)
  );
  if (!upload) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Storage first, then the DB transition — if completion fails the source
  // stays "uploading" and the client can retry completing.
  await completeMultipartUpload(
    upload.storageKey,
    upload.uploadId,
    parsed.data.parts
  );
  const head = await headObject(upload.storageKey);

  await withOrgScope(organizationId, async (tx) => {
    await tx
      .update(source)
      .set({ sizeBytes: head.size, status: "uploaded", uploadId: null })
      .where(eq(source.id, upload.id));

    await recordUsage(tx, {
      correlationId: `storage:original:${upload.id}`,
      entryType: "storage_bytes",
      metadata: { category: "original", storageKey: upload.storageKey },
      organizationId,
      quantity: head.size,
      sourceId: upload.id,
      unit: "bytes",
    });

    await recordAudit(tx, {
      action: "source.uploaded",
      actorUserId: userId,
      entityId: upload.id,
      entityType: "source",
      metadata: { sizeBytes: head.size },
      organizationId,
    });
  });

  await enqueueIngest({ organizationId, sourceId: upload.id });

  return Response.json({ ok: true });
}
