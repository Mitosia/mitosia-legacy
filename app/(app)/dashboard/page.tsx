import { count } from "drizzle-orm";
import Link from "next/link";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { brand, campaign, client, project } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { requireOrg } from "@/lib/org";

export default async function DashboardPage() {
  const { organizationId, session } = await requireOrg();

  const stats = await withOrgScope(organizationId, async (tx) => {
    const [clients] = await tx.select({ value: count() }).from(client);
    const [brands] = await tx.select({ value: count() }).from(brand);
    const [campaigns] = await tx.select({ value: count() }).from(campaign);
    const [projects] = await tx.select({ value: count() }).from(project);

    return [
      { href: "/clients", label: "Clients", value: clients?.value ?? 0 },
      { href: "/clients", label: "Brands", value: brands?.value ?? 0 },
      { href: "/clients", label: "Campaigns", value: campaigns?.value ?? 0 },
      { href: "/clients", label: "Projects", value: projects?.value ?? 0 },
    ];
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-semibold text-2xl">Welcome, {session.user.name}</h1>
        <p className="text-muted-foreground text-sm">
          Set up clients and brands now — sources and campaigns arrive in the
          next sprints.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((stat) => (
          <Link href={stat.href} key={stat.label}>
            <Card>
              <CardHeader>
                <CardDescription>{stat.label}</CardDescription>
                <CardTitle className="text-3xl">{stat.value}</CardTitle>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
