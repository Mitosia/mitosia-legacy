import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { EntityList } from "@/components/entity-list";
import { InlineCreateForm } from "@/components/forms/inline-create-form";
import { createCampaignAction } from "@/lib/actions/hierarchy";
import { brand, campaign, client } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { requireOrg } from "@/lib/org";

export default async function BrandDetailPage(
  props: PageProps<"/brands/[brandId]">
) {
  const { brandId } = await props.params;
  const parsedId = z.uuid().safeParse(brandId);

  if (!parsedId.success) {
    notFound();
  }

  const { organizationId } = await requireOrg();

  const data = await withOrgScope(organizationId, async (tx) => {
    const [brandRow] = await tx
      .select({
        clientId: brand.clientId,
        clientName: client.name,
        id: brand.id,
        name: brand.name,
      })
      .from(brand)
      .innerJoin(client, eq(brand.clientId, client.id))
      .where(eq(brand.id, parsedId.data))
      .limit(1);

    if (!brandRow) {
      return null;
    }

    const campaigns = await tx
      .select({ id: campaign.id, name: campaign.name })
      .from(campaign)
      .where(eq(campaign.brandId, brandRow.id))
      .orderBy(desc(campaign.createdAt));

    return { brand: brandRow, campaigns };
  });

  if (!data) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-muted-foreground text-sm">
          <Link className="hover:underline" href="/clients">
            Clients
          </Link>{" "}
          /{" "}
          <Link
            className="hover:underline"
            href={`/clients/${data.brand.clientId}`}
          >
            {data.brand.clientName}
          </Link>{" "}
          / {data.brand.name}
        </p>
        <h1 className="font-semibold text-2xl">{data.brand.name}</h1>
      </div>
      <section className="flex flex-col gap-4">
        <h2 className="font-medium text-lg">Campaigns</h2>
        <InlineCreateForm
          action={createCampaignAction}
          buttonLabel="Add campaign"
          hiddenFields={{ brandId: data.brand.id }}
          label="New campaign"
          placeholder="Campaign name"
        />
        <EntityList
          emptyLabel="No campaigns yet for this brand."
          items={data.campaigns.map((row) => ({
            href: `/campaigns/${row.id}`,
            id: row.id,
            name: row.name,
          }))}
        />
      </section>
    </div>
  );
}
