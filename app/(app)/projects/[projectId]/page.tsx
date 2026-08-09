import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { campaign, project } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { requireOrg } from "@/lib/org";

export default async function ProjectDetailPage(
  props: PageProps<"/projects/[projectId]">
) {
  const { projectId } = await props.params;
  const parsedId = z.uuid().safeParse(projectId);

  if (!parsedId.success) {
    notFound();
  }

  const { organizationId } = await requireOrg();

  const data = await withOrgScope(organizationId, async (tx) => {
    const [projectRow] = await tx
      .select({
        campaignId: project.campaignId,
        campaignName: campaign.name,
        id: project.id,
        name: project.name,
      })
      .from(project)
      .innerJoin(campaign, eq(project.campaignId, campaign.id))
      .where(eq(project.id, parsedId.data))
      .limit(1);

    return projectRow ?? null;
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
            href={`/campaigns/${data.campaignId}`}
          >
            {data.campaignName}
          </Link>{" "}
          / {data.name}
        </p>
        <h1 className="font-semibold text-2xl">{data.name}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Production container</CardTitle>
          <CardDescription>
            Sources, transcripts, and moments land here in Sprint S2.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            This project is ready to receive source material once ingestion
            ships.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
