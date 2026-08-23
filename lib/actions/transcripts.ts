"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { recordAudit } from "@/lib/audit";
import { transcript } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { requireOrg } from "@/lib/org";
import {
  createCorrectionRevision,
  StaleRevisionError,
} from "@/lib/transcription/corrections";
import { InvalidEditError } from "@/lib/transcription/edits";

const speakerLabelsSchema = z.object({
  // Speaker id → display name. Empty names clear the label (fall back to
  // "Speaker N"); the SAME name on several ids is the sanctioned way to
  // merge an over-segmented diarization (one voice split into two ids).
  labels: z.record(z.string().max(16), z.string().trim().max(80)),
  sourceId: z.uuid(),
});

export async function updateSpeakerLabelsAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = speakerLabelsSchema.safeParse({
    labels: JSON.parse(String(formData.get("labels") ?? "{}")),
    sourceId: formData.get("sourceId"),
  });
  if (!parsed.success) {
    return { error: "Invalid speaker labels" };
  }
  const { organizationId, userId } = await requireOrg();

  const labels: Record<string, string> = {};
  for (const [speaker, name] of Object.entries(parsed.data.labels)) {
    if (name.length > 0) {
      labels[speaker] = name;
    }
  }

  const updated = await withOrgScope(organizationId, async (tx) => {
    const [row] = await tx
      .update(transcript)
      .set({ speakerLabels: labels })
      .where(eq(transcript.sourceId, parsed.data.sourceId))
      .returning({ id: transcript.id });
    if (!row) {
      return false;
    }
    await recordAudit(tx, {
      action: "transcript.speakers_renamed",
      actorUserId: userId,
      entityId: row.id,
      entityType: "transcript",
      metadata: { labels },
      organizationId,
    });
    return true;
  });

  if (!updated) {
    return { error: "Transcript not found" };
  }
  revalidatePath(`/sources/${parsed.data.sourceId}`);
  return { success: true };
}

const correctWordSchema = z.object({
  baseRevision: z.coerce.number().int().positive(),
  sourceId: z.uuid(),
  text: z.string().trim().min(1).max(200),
  wordIndex: z.coerce.number().int().nonnegative(),
});

export async function correctWordAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = correctWordSchema.safeParse({
    baseRevision: formData.get("baseRevision"),
    sourceId: formData.get("sourceId"),
    text: formData.get("text"),
    wordIndex: formData.get("wordIndex"),
  });
  if (!parsed.success) {
    return { error: "Invalid correction" };
  }
  const { organizationId, userId } = await requireOrg();

  try {
    await createCorrectionRevision({
      baseRevision: parsed.data.baseRevision,
      edits: [{ index: parsed.data.wordIndex, text: parsed.data.text }],
      organizationId,
      sourceId: parsed.data.sourceId,
      userId,
    });
  } catch (error) {
    if (
      error instanceof StaleRevisionError ||
      error instanceof InvalidEditError
    ) {
      return { error: error.message };
    }
    console.error("[transcript] correction failed:", error);
    return { error: "The correction could not be saved. Try again." };
  }

  revalidatePath(`/sources/${parsed.data.sourceId}`);
  return { success: true };
}
