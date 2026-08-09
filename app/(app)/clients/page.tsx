import { desc } from "drizzle-orm";
import { EntityList } from "@/components/entity-list";
import { InlineCreateForm } from "@/components/forms/inline-create-form";
import { createClientAction } from "@/lib/actions/hierarchy";
import { client } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { requireOrg } from "@/lib/org";

export default async function ClientsPage() {
  const { organizationId } = await requireOrg();

  const clients = await withOrgScope(organizationId, (tx) =>
    tx
      .select({ id: client.id, name: client.name, status: client.status })
      .from(client)
      .orderBy(desc(client.createdAt))
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-semibold text-2xl">Clients</h1>
        <p className="text-muted-foreground text-sm">
          Each client owns its brands, campaigns, and projects.
        </p>
      </div>
      <InlineCreateForm
        action={createClientAction}
        buttonLabel="Add client"
        label="New client"
        placeholder="Client name"
      />
      <EntityList
        emptyLabel="No clients yet. Create the first one above."
        items={clients.map((row) => ({
          href: `/clients/${row.id}`,
          id: row.id,
          meta: row.status,
          name: row.name,
        }))}
      />
    </div>
  );
}
