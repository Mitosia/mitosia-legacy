"use server";

import { APIError } from "better-auth";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { auth } from "@/lib/auth";

const inviteSchema = z.object({
  email: z.email("Enter a valid email address."),
  role: z.enum(["admin", "member"]),
});

export async function inviteMemberAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message };
  }

  try {
    // Membership/role authorization is enforced by Better Auth itself.
    await auth.api.createInvitation({
      body: { email: parsed.data.email, role: parsed.data.role },
      headers: await headers(),
    });
  } catch (error) {
    if (error instanceof APIError) {
      return { error: error.message };
    }
    return { error: "Unable to create the invitation." };
  }

  revalidatePath("/settings/members");
  return { success: true };
}

export async function cancelInvitationAction(formData: FormData) {
  const invitationId = z
    .string()
    .min(1)
    .safeParse(formData.get("invitationId"));

  if (!invitationId.success) {
    return;
  }

  try {
    await auth.api.cancelInvitation({
      body: { invitationId: invitationId.data },
      headers: await headers(),
    });
  } catch {
    // Surfacing cancel failures is not worth a dedicated error state in v1.
  }

  revalidatePath("/settings/members");
}
