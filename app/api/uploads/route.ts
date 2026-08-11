import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireOrgApi } from "@/lib/api-auth";
import { recordAudit } from "@/lib/audit";
import { brand, campaign, project, source } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { createMultipartUpload, listUploadedParts } from "@/lib/storage";
import { sourceOriginalKey } from "@/lib/storage/keys";
import { findAdoptableUpload } from "@/lib/uploads";

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

const findUploadSchema = z.object({
  filename: z.string().trim().min(1).max(500),
  projectId: z.uuid(),
  size: z.coerce.number().int().positive().max(MAX_UPLOAD_BYTES),
});

// An adoptable row is only worth handing back if storage still has the
// multipart upload behind it — the reaper or R2's own abort rule may have
// released it, and a dead upload id fails on the first signed part.
async function verifyStorageStillHas(upload: {
  storageKey: string;
  uploadId: string;
}): Promise<boolean> {
  try {
    await listUploadedParts(upload.storageKey, upload.uploadId);
    return true;
  } catch {
    return false;
  }
}

// "Do you already have an unfinished upload of this exact file?" Asked when
// a file is added and the browser has no resume state of its own, so the
// client can attach to it and skip the parts storage already holds. Answers
// null rather than 404 — no match is the normal case, not an error.
export async function GET(request: Request) {
  const ctx = await requireOrgApi();
  if (ctx.error) {
    return ctx.error;
  }

  const url = new URL(request.url);
  const parsed = findUploadSchema.safeParse({
    filename: url.searchParams.get("filename"),
    projectId: url.searchParams.get("projectId"),
    size: url.searchParams.get("size"),
  });
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message },
      { status: 400 }
    );
  }
  const { filename, projectId, size } = parsed.data;

  const upload = await withOrgScope(ctx.organizationId, (tx) =>
    findAdoptableUpload(tx, { filename, projectId, sizeBytes: size })
  );

  if (!(upload && (await verifyStorageStillHas(upload)))) {
    return Response.json({ upload: null });
  }

  return Response.json({
    upload: {
      key: upload.storageKey,
      sourceId: upload.id,
      uploadId: upload.uploadId,
    },
  });
}

// Starts a resumable multipart upload: creates the source record
// (lifecycle: uploading) and the storage-side multipart upload.
export async function POST(request: Request) {
  const ctx = await requireOrgApi();
  if (ctx.error) {
    return ctx.error;
  }
  const { organizationId, userId } = ctx;

  // A client that goes away mid-request leaves a truncated body, and an
  // uncaught JSON parse error is a 500 for what is really a bad request.
  const parsed = createUploadSchema.safeParse(
    await request.json().catch(() => null)
  );
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

    // Second line of defence. The client asks GET first and normally
    // attaches without ever reaching here, but that lookup is async and a
    // fast click can beat it. Re-checking inside the same transaction means
    // a duplicate row is not merely unlikely, it is unreachable — worst
    // case the upload re-sends parts storage already has, which is wasted
    // bandwidth rather than a stranded upload and a ghost row.
    const adoptable = await findAdoptableUpload(tx, {
      filename,
      projectId,
      sizeBytes: size,
    });
    if (adoptable && (await verifyStorageStillHas(adoptable))) {
      return {
        key: adoptable.storageKey,
        sourceId: adoptable.id,
        uploadId: adoptable.uploadId,
      };
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
