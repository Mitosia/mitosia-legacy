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
      })
      .from(source)
      .where(eq(source.id, parsedId.data))
      .limit(1);

    if (row?.status !== "failed") {
      return null;
    }

    await recordAudit(tx, {
      action: "source.ingest_retried",
      actorUserId: userId,
      entityId: row.id,
      entityType: "source",
      organizationId,
    });
    return row;
  });

  if (!sourceRow) {
    return { error: "Only failed sources can be retried." };
  }

  await enqueueIngest({ organizationId, sourceId: sourceRow.id });

  revalidatePath(`/projects/${sourceRow.projectId}`);
  revalidatePath(`/sources/${sourceRow.id}`);
  return { success: true };
}
