import { z } from "zod";
import { requireOrgApi } from "@/lib/api-auth";
import { withOrgScope } from "@/lib/db/tenant";
import { listUploadedParts, presignUploadPart } from "@/lib/storage";
import { loadUploadingSource, touchUpload } from "@/lib/uploads";

const signPartSchema = z.object({
  // S3 multipart hard limit
  partNumber: z.number().int().min(1).max(10_000),
});

const sourceIdSchema = z.uuid();

// `touch` refreshes the reaper's liveness stamp, and only signing a part
// earns it: parts go straight to storage, so this is the sole trace an
// upload that is actually moving leaves on the app server. Listing parts
// must NOT count — a restored page asks that question about uploads it may
// well abandon again, and an abandoned upload that answers "still alive"
// every time someone opens the page is never reaped.
async function resolveSource(
  sourceIdParam: string,
  { touch }: { touch: boolean }
) {
  const parsedId = sourceIdSchema.safeParse(sourceIdParam);
  if (!parsedId.success) {
    return { error: Response.json({ error: "Not found" }, { status: 404 }) };
  }

  const ctx = await requireOrgApi();
  if (ctx.error) {
    return { error: ctx.error };
  }

  const upload = await withOrgScope(ctx.organizationId, async (tx) => {
    const row = await loadUploadingSource(tx, parsedId.data);
    if (row && touch) {
      await touchUpload(tx, row.id);
    }
    return row;
  });
  if (!upload) {
    return { error: Response.json({ error: "Not found" }, { status: 404 }) };
  }

  return { upload };
}

// Presigns a single part upload URL (called by Uppy per part).
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/uploads/[sourceId]/parts">
) {
  const { sourceId } = await ctx.params;
  const resolved = await resolveSource(sourceId, { touch: true });
  if (resolved.error) {
    return resolved.error;
  }

  const parsed = signPartSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return Response.json({ error: "Invalid part number" }, { status: 400 });
  }

  const url = await presignUploadPart(
    resolved.upload.storageKey,
    resolved.upload.uploadId,
    parsed.data.partNumber
  );

  return Response.json({ url });
}

// Lists already-uploaded parts so a paused or interrupted upload resumes
// instead of restarting (Uppy calls this on retry).
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/uploads/[sourceId]/parts">
) {
  const { sourceId } = await ctx.params;
  const resolved = await resolveSource(sourceId, { touch: false });
  if (resolved.error) {
    return resolved.error;
  }

  const parts = await listUploadedParts(
    resolved.upload.storageKey,
    resolved.upload.uploadId
  );

  return Response.json({
    parts: parts.map((part) => ({
      ETag: part.etag,
      PartNumber: part.partNumber,
      Size: part.size,
    })),
  });
}
