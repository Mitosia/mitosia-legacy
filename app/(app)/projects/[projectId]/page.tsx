import { and, desc, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { RefreshPoller } from "@/components/sources/refresh-poller";
import {
  SourceList,
  type SourceListItem,
} from "@/components/sources/source-list";
import { SourceUploader } from "@/components/sources/source-uploader";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { campaign, project, source, sourceArtifact } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { requireOrg } from "@/lib/org";
import { isStaleUpload, scheduleUploadReap } from "@/lib/uploads";

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

    if (!projectRow) {
      return null;
    }

    const sourceRows = await tx
      .select({
        durationSeconds: source.durationSeconds,
        id: source.id,
        ingestError: source.ingestError,
        ingestStep: source.ingestStep,
        sizeBytes: source.sizeBytes,
        // Computed in the database (time-zone-safe) rather than compared
        // against a JS clock here: whether this row is an abandoned upload.
        stale: sql<boolean>`(${isStaleUpload})`,
        status: source.status,
        title: source.title,
      })
      .from(source)
      .where(eq(source.projectId, projectRow.id))
      .orderBy(desc(source.createdAt));

    const posterRows =
      sourceRows.length > 0
        ? await tx
            .select({
              sourceId: sourceArtifact.sourceId,
              storageKey: sourceArtifact.storageKey,
            })
            .from(sourceArtifact)
            .where(
              and(
                eq(sourceArtifact.kind, "poster"),
                inArray(
                  sourceArtifact.sourceId,
                  sourceRows.map((row) => row.id)
                )
              )
            )
        : [];
    const posterBySource = new Map(
      posterRows.map((row) => [row.sourceId, row.storageKey])
    );

    const sources: SourceListItem[] = sourceRows.map(
      ({ stale: _stale, ...row }) => ({
        ...row,
        posterKey: posterBySource.get(row.id) ?? null,
      })
    );

    return {
      ...projectRow,
      hasStaleUpload: sourceRows.some((row) => row.stale),
      sources,
    };
  });

  if (!data) {
    notFound();
  }

  // This list is where abandoned uploads show up as permanently-uploading
  // ghosts, so it is what pays for the sweep — scheduled after the response
  // flushes, and only when one is actually on the page. The RefreshPoller
  // is already running (the row still reads "uploading"), so the transition
  // to failed lands on its next tick.
  if (data.hasStaleUpload) {
    scheduleUploadReap(organizationId);
  }

  const hasActiveSources = data.sources.some(
    (item) =>
      item.status === "uploading" ||
      item.status === "uploaded" ||
      item.status === "processing"
  );

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
          <CardTitle>Upload sources</CardTitle>
          <CardDescription>
            Long-form recordings upload with pause and resume, then are prepared
            for playback automatically. An upload interrupted by a closed tab
            keeps its place for a day — re-select the same file to continue it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SourceUploader projectId={data.id} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
          <CardDescription>
            All recordings in this project, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RefreshPoller active={hasActiveSources} />
          <SourceList items={data.sources} />
          <p className="mt-3 text-muted-foreground text-xs">
            Recordings are prepared for fast playback and editing — usually a
            few minutes.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
