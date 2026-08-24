"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { recordAudit } from "@/lib/audit";
import { sourceExtractionRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { enqueueExtractionRerun } from "@/lib/intelligence/extract-enqueue";
import { requireOrg } from "@/lib/org";

// Re-running extraction is a HUMAN action by design (AGENTS §Source
// intelligence): a failed run must not become a paid retry loop, and
// re-extracting after transcript corrections re-spends real model tokens.
// claimRun() in the pipeline makes double-clicks collapse to one run.
export async function rerunExtractionAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsedId = z.uuid().safeParse(formData.get("sourceId"));
  if (!parsedId.success) {
    return { error: "Invalid source reference." };
  }
  const { organizationId, userId } = await requireOrg();

  const run = await withOrgScope(organizationId, async (tx) => {
    const [row] = await tx
      .select({
        id: sourceExtractionRun.id,
        status: sourceExtractionRun.status,
      })
      .from(sourceExtractionRun)
      .where(eq(sourceExtractionRun.sourceId, parsedId.data))
      .limit(1);
    return row ?? null;
  });
  if (!run) {
    return { error: "This source has no extraction to re-run." };
  }
  if (run.status === "processing" || run.status === "pending") {
    return { error: "Extraction is already running." };
  }

  await withOrgScope(organizationId, (tx) =>
    recordAudit(tx, {
      action: "source_extraction.rerun",
      actorUserId: userId,
      entityId: run.id,
      entityType: "source_extraction_run",
      organizationId,
    })
  );
  await enqueueExtractionRerun({ organizationId, sourceId: parsedId.data });

  revalidatePath(`/sources/${parsedId.data}`);
  return { success: true };
}
