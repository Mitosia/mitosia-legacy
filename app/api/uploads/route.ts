import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireOrgApi } from "@/lib/api-auth";
import { recordAudit } from "@/lib/audit";
import { brand, campaign, project, source } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { createMultipartUpload } from "@/lib/storage";
import { sourceOriginalKey } from "@/lib/storage/keys";

// 20 GB — generous headroom over the 2 GB / two-hour exit-test recording.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;

const FILE_EXTENSION = /\.[^.]+$/;

const createUploadSchema = z.object({
  filename: z.string().trim().min(1).max(500),
  projectId: z.uuid(),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  type: z
    .string()
    .regex(/^(video|audio)\//, "Only video and audio files can be ingested."),
});

// Starts a resumable multipart upload: creates the source record
// (lifecycle: uploading) and the storage-side multipart upload.
export async function POST(request: Request) {
  const ctx = await requireOrgApi();
  if (ctx.error) {
    return ctx.error;
  }
  const { organizationId, userId } = ctx;

  const parsed = createUploadSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message },
      { status: 400 }
    );
  }
  const { filename, projectId, size, type } = parsed.data;

  const result = await withOrgScope(organizationId, async (tx) => {
    // Re-read the parent chain inside the org scope (RLS): a cross-tenant
    // project id is simply invisible here. The client id feeds the key
    // scheme's org/client storage prefix.
    const [projectRow] = await tx
      .select({ clientId: brand.clientId, id: project.id })
      .from(project)
      .innerJoin(campaign, eq(project.campaignId, campaign.id))
      .innerJoin(brand, eq(campaign.brandId, brand.id))
      .where(eq(project.id, projectId))
      .limit(1);

    if (!projectRow) {
      return null;
    }

    // uuidv7 (native in Postgres 18) keeps source ids index-local; the id
    // must exist before insert because the storage key embeds it.
    const idRows = await tx.execute<{ id: string }>(sql`SELECT uuidv7() AS id`);
    const sourceId = idRows.rows[0]?.id;
    if (!sourceId) {
      throw new Error("Failed to allocate source id");
    }

    const key = sourceOriginalKey(
      { clientId: projectRow.clientId, organizationId, sourceId },
      filename
    );
    const uploadId = await createMultipartUpload(key, type);

    await tx.insert(source).values({
      createdBy: userId,
      id: sourceId,
      mimeType: type,
      organizationId,
      originalFilename: filename,
      projectId,
      sizeBytes: size,
      status: "uploading",
      storageKey: key,
      title: filename.replace(FILE_EXTENSION, ""),
      uploadId,
    });

    await recordAudit(tx, {
      action: "source.upload_started",
      actorUserId: userId,
      entityId: sourceId,
      entityType: "source",
      metadata: { filename, projectId, size },
      organizationId,
    });

    return { key, sourceId, uploadId };
  });

  if (!result) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  return Response.json(result);
}
