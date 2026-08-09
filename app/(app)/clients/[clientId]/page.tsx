import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { EntityList } from "@/components/entity-list";
import { InlineCreateForm } from "@/components/forms/inline-create-form";
import { Badge } from "@/components/ui/badge";
import { createBrandAction } from "@/lib/actions/hierarchy";
import { brand, client } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { requireOrg } from "@/lib/org";

export default async function ClientDetailPage(
  props: PageProps<"/clients/[clientId]">
) {
  const { clientId } = await props.params;
  const parsedId = z.uuid().safeParse(clientId);

  if (!parsedId.success) {
    notFound();
  }

  const { organizationId } = await requireOrg();

  const data = await withOrgScope(organizationId, async (tx) => {
    const [clientRow] = await tx
      .select()
      .from(client)
      .where(eq(client.id, parsedId.data))
      .limit(1);

    if (!clientRow) {
      return null;
    }

    const brands = await tx
      .select({ id: brand.id, name: brand.name })
      .from(brand)
      .where(eq(brand.clientId, clientRow.id))
      .orderBy(desc(brand.createdAt));

    return { brands, client: clientRow };
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
          / {data.client.name}
        </p>
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-2xl">{data.client.name}</h1>
          <Badge variant="outline">{data.client.status}</Badge>
        </div>
      </div>
      <section className="flex flex-col gap-4">
        <h2 className="font-medium text-lg">Brands</h2>
        <InlineCreateForm
          action={createBrandAction}
          buttonLabel="Add brand"
          hiddenFields={{ clientId: data.client.id }}
          label="New brand"
          placeholder="Brand name"
        />
        <EntityList
          emptyLabel="No brands yet for this client."
          items={data.brands.map((row) => ({
            href: `/brands/${row.id}`,
            id: row.id,
            name: row.name,
          }))}
        />
      </section>
    </div>
  );
}
