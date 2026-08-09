import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { EntityList } from "@/components/entity-list";
import { InlineCreateForm } from "@/components/forms/inline-create-form";
import { createProjectAction } from "@/lib/actions/hierarchy";
import { brand, campaign, project } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { requireOrg } from "@/lib/org";

export default async function CampaignDetailPage(
  props: PageProps<"/campaigns/[campaignId]">
) {
  const { campaignId } = await props.params;
  const parsedId = z.uuid().safeParse(campaignId);

  if (!parsedId.success) {
    notFound();
  }

  const { organizationId } = await requireOrg();

  const data = await withOrgScope(organizationId, async (tx) => {
    const [campaignRow] = await tx
      .select({
        brandId: campaign.brandId,
        brandName: brand.name,
        id: campaign.id,
        name: campaign.name,
      })
      .from(campaign)
      .innerJoin(brand, eq(campaign.brandId, brand.id))
      .where(eq(campaign.id, parsedId.data))
      .limit(1);

    if (!campaignRow) {
      return null;
    }

    const projects = await tx
      .select({ id: project.id, name: project.name })
      .from(project)
      .where(eq(project.campaignId, campaignRow.id))
      .orderBy(desc(project.createdAt));

    return { campaign: campaignRow, projects };
  });

  if (!data) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-muted-foreground text-sm">
          <Link
            className="hover:underline"
            href={`/brands/${data.campaign.brandId}`}
          >
            {data.campaign.brandName}
          </Link>{" "}
          / {data.campaign.name}
        </p>
        <h1 className="font-semibold text-2xl">{data.campaign.name}</h1>
      </div>
      <section className="flex flex-col gap-4">
        <h2 className="font-medium text-lg">Projects</h2>
        <InlineCreateForm
          action={createProjectAction}
          buttonLabel="Add project"
          hiddenFields={{ campaignId: data.campaign.id }}
          label="New project"
          placeholder="Project name"
        />
        <EntityList
          emptyLabel="No projects yet for this campaign."
          items={data.projects.map((row) => ({
            href: `/projects/${row.id}`,
            id: row.id,
            name: row.name,
          }))}
        />
      </section>
    </div>
  );
}
