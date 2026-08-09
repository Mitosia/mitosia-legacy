"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { recordAudit } from "@/lib/audit";
import { brand, campaign, client, project } from "@/lib/db/schema";
import { type OrgTransaction, withOrgScope } from "@/lib/db/tenant";
import { requireOrg } from "@/lib/org";

const nameSchema = z.string().trim().min(1, "Name is required.").max(200);
const uuidSchema = z.uuid();

// Foreign keys are validated by Postgres with owner rights, which does not
// consult RLS — so every parent reference is re-read inside the org scope
// first. A parent belonging to another tenant is simply invisible here.
async function assertVisible(
  tx: OrgTransaction,
  table: typeof brand | typeof campaign | typeof client,
  id: string,
  label: string
) {
  const [row] = await tx
    .select({ id: table.id })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);

  if (!row) {
    throw new Error(`${label} not found.`);
  }
}

export async function createClientAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsedName = nameSchema.safeParse(formData.get("name"));

  if (!parsedName.success) {
    return { error: parsedName.error.issues[0]?.message };
  }

  const { organizationId, userId } = await requireOrg();

  await withOrgScope(organizationId, async (tx) => {
    const [row] = await tx
      .insert(client)
      .values({ name: parsedName.data, organizationId })
      .returning({ id: client.id });

    await recordAudit(tx, {
      action: "client.created",
      actorUserId: userId,
      entityId: row?.id,
      entityType: "client",
      organizationId,
    });
  });

  revalidatePath("/clients");
  return { success: true };
}

export async function createBrandAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsedName = nameSchema.safeParse(formData.get("name"));
  const parsedClientId = uuidSchema.safeParse(formData.get("clientId"));

  if (!parsedName.success) {
    return { error: parsedName.error.issues[0]?.message };
  }
  if (!parsedClientId.success) {
    return { error: "Invalid client reference." };
  }

  const { organizationId, userId } = await requireOrg();

  try {
    await withOrgScope(organizationId, async (tx) => {
      await assertVisible(tx, client, parsedClientId.data, "Client");

      const [row] = await tx
        .insert(brand)
        .values({
          clientId: parsedClientId.data,
          name: parsedName.data,
          organizationId,
        })
        .returning({ id: brand.id });

      await recordAudit(tx, {
        action: "brand.created",
        actorUserId: userId,
        entityId: row?.id,
        entityType: "brand",
        metadata: { clientId: parsedClientId.data },
        organizationId,
      });
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to create.",
    };
  }

  revalidatePath(`/clients/${parsedClientId.data}`);
  return { success: true };
}

export async function createCampaignAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsedName = nameSchema.safeParse(formData.get("name"));
  const parsedBrandId = uuidSchema.safeParse(formData.get("brandId"));

  if (!parsedName.success) {
    return { error: parsedName.error.issues[0]?.message };
  }
  if (!parsedBrandId.success) {
    return { error: "Invalid brand reference." };
  }

  const { organizationId, userId } = await requireOrg();

  try {
    await withOrgScope(organizationId, async (tx) => {
      await assertVisible(tx, brand, parsedBrandId.data, "Brand");

      const [row] = await tx
        .insert(campaign)
        .values({
          brandId: parsedBrandId.data,
          name: parsedName.data,
          organizationId,
        })
        .returning({ id: campaign.id });

      await recordAudit(tx, {
        action: "campaign.created",
        actorUserId: userId,
        entityId: row?.id,
        entityType: "campaign",
        metadata: { brandId: parsedBrandId.data },
        organizationId,
      });
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to create.",
    };
  }

  revalidatePath(`/brands/${parsedBrandId.data}`);
  return { success: true };
}

export async function createProjectAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsedName = nameSchema.safeParse(formData.get("name"));
  const parsedCampaignId = uuidSchema.safeParse(formData.get("campaignId"));

  if (!parsedName.success) {
    return { error: parsedName.error.issues[0]?.message };
  }
  if (!parsedCampaignId.success) {
    return { error: "Invalid campaign reference." };
  }

  const { organizationId, userId } = await requireOrg();

  try {
    await withOrgScope(organizationId, async (tx) => {
      await assertVisible(tx, campaign, parsedCampaignId.data, "Campaign");

      const [row] = await tx
        .insert(project)
        .values({
          campaignId: parsedCampaignId.data,
          name: parsedName.data,
          organizationId,
        })
        .returning({ id: project.id });

      await recordAudit(tx, {
        action: "project.created",
        actorUserId: userId,
        entityId: row?.id,
        entityType: "project",
        metadata: { campaignId: parsedCampaignId.data },
        organizationId,
      });
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to create.",
    };
  }

  revalidatePath(`/campaigns/${parsedCampaignId.data}`);
  return { success: true };
}
