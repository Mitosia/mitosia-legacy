"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { recordAudit } from "@/lib/audit";
import { source } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { enqueueIngest } from "@/lib/ingest";
import { requireOrg } from "@/lib/org";
import { headObject } from "@/lib/storage";

// Failures surface with retry (S2 exit criterion): a failed source can be
// re-run end to end. claimSource() in the pipeline flips it back to
// processing, so double-clicks and concurrent retries collapse to one run.
export async function retryIngestAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsedId = z.uuid().safeParse(formData.get("sourceId"));
  if (!parsedId.success) {
    return { error: "Invalid source reference." };
  }

  const { organizationId, userId } = await requireOrg();

  const sourceRow = await withOrgScope(organizationId, async (tx) => {
    const [row] = await tx
      .select({
        id: source.id,
        projectId: source.projectId,
        status: source.status,
        storageKey: source.storageKey,
      })
      .from(source)
      .where(eq(source.id, parsedId.data))
      .limit(1);

    if (row?.status !== "failed") {
      return null;
    }
    return row;
  });

  if (!sourceRow) {
    return { error: "Only failed sources can be retried." };
  }

  // A source can also reach "failed" without ever having an original —
  // that is what the stale-upload sweep does to an abandoned upload. The
  // pipeline would run and fail again on the missing object, so say what
  // actually has to happen instead.
  const hasOriginal = await headObject(sourceRow.storageKey)
    .then(() => true)
    .catch(() => false);
  if (!hasOriginal) {
    return {
      error: "This upload never finished. Upload the file again to replace it.",
    };
  }

  await withOrgScope(organizationId, (tx) =>
    recordAudit(tx, {
      action: "source.ingest_retried",
      actorUserId: userId,
      entityId: sourceRow.id,
      entityType: "source",
      organizationId,
    })
  );

  await enqueueIngest({ organizationId, sourceId: sourceRow.id });

  revalidatePath(`/projects/${sourceRow.projectId}`);
  revalidatePath(`/sources/${sourceRow.id}`);
  return { success: true };
}
