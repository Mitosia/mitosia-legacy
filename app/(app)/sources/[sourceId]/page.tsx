import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { RefreshPoller } from "@/components/sources/refresh-poller";
import { RetryIngestButton } from "@/components/sources/retry-ingest-button";
import { SourcePlayer } from "@/components/sources/source-player";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { project, source, sourceArtifact } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { formatBytes, formatDuration } from "@/lib/format";
import { requireOrg } from "@/lib/org";

interface ProbeMetadata {
  audio?: { channels: number; codec: string; sampleRate: number };
  container?: string;
  video?: { codec: string; fps: number; height: number; width: number };
}

interface SourceFactsInput {
  durationSeconds: number | null;
  metadata: unknown;
  originalFilename: string;
  sizeBytes: number | null;
}

function buildFacts(
  data: SourceFactsInput
): { label: string; value: string }[] {
  const probe = (data.metadata ?? {}) as ProbeMetadata;
  const facts: { label: string; value: string }[] = [];

  if (data.durationSeconds) {
    facts.push({
      label: "Duration",
      value: formatDuration(data.durationSeconds),
    });
  }
  if (data.sizeBytes) {
    facts.push({ label: "Size", value: formatBytes(data.sizeBytes) });
  }
  if (probe.video) {
    facts.push({
      label: "Video",
      value: `${probe.video.codec} · ${probe.video.width}×${probe.video.height} · ${probe.video.fps.toFixed(2)} fps`,
    });
  }
  if (probe.audio) {
    facts.push({
      label: "Audio",
      value: `${probe.audio.codec} · ${probe.audio.channels} ch · ${probe.audio.sampleRate} Hz`,
    });
  }
  facts.push({ label: "Original file", value: data.originalFilename });
  return facts;
}

function PipelineStateCard({
  ingestError,
  sourceId,
  status,
}: {
  ingestError: string | null;
  sourceId: string;
  status: string;
}) {
  const failed = status === "failed";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{failed ? "Ingest failed" : "Preparing proxy"}</CardTitle>
        <CardDescription>
          {failed
            ? (ingestError ?? "The pipeline hit an unexpected error.")
            : "The proxy, thumbnails, and waveform are being generated. This page updates automatically."}
        </CardDescription>
      </CardHeader>
      {failed ? (
        <CardContent>
          <RetryIngestButton sourceId={sourceId} />
        </CardContent>
      ) : null}
    </Card>
  );
}

export default async function SourceDetailPage(
  props: PageProps<"/sources/[sourceId]">
) {
  const { sourceId } = await props.params;
  const parsedId = z.uuid().safeParse(sourceId);

  if (!parsedId.success) {
    notFound();
  }

  const { organizationId } = await requireOrg();

  const data = await withOrgScope(organizationId, async (tx) => {
    const [sourceRow] = await tx
      .select({
        durationSeconds: source.durationSeconds,
        id: source.id,
        ingestError: source.ingestError,
        ingestStep: source.ingestStep,
        metadata: source.metadata,
        originalFilename: source.originalFilename,
        projectId: source.projectId,
        projectName: project.name,
        sizeBytes: source.sizeBytes,
        status: source.status,
        title: source.title,
      })
      .from(source)
      .innerJoin(project, eq(source.projectId, project.id))
      .where(eq(source.id, parsedId.data))
      .limit(1);

    if (!sourceRow) {
      return null;
    }

    const artifacts = await tx
      .select({
        kind: sourceArtifact.kind,
        storageKey: sourceArtifact.storageKey,
      })
      .from(sourceArtifact)
      .where(eq(sourceArtifact.sourceId, sourceRow.id));

    return { ...sourceRow, artifacts };
  });

  if (!data) {
    notFound();
  }

  const artifactKey = (kind: string) =>
    data.artifacts.find((artifact) => artifact.kind === kind)?.storageKey ??
    null;

  const hlsKey = artifactKey("hls_master");
  const posterKey = artifactKey("poster");
  const waveformKey = artifactKey("waveform");
  const facts = buildFacts(data);
  const isSettled = data.status === "ready" || data.status === "failed";

  return (
    <div className="flex flex-col gap-6">
      <RefreshPoller active={!isSettled} />
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm">
            <Link
              className="hover:underline"
              href={`/projects/${data.projectId}`}
            >
              {data.projectName}
            </Link>{" "}
            / {data.title}
          </p>
          <h1 className="font-semibold text-2xl">{data.title}</h1>
        </div>
        {data.status === "ready" ? (
          <Badge>Ready</Badge>
        ) : (
          <Badge
            variant={data.status === "failed" ? "destructive" : "secondary"}
          >
            {data.status === "processing" && data.ingestStep
              ? `Processing: ${data.ingestStep}`
              : data.status}
          </Badge>
        )}
      </div>

      {data.status === "ready" && hlsKey ? (
        <SourcePlayer
          hlsUrl={`/api/media/${hlsKey}`}
          peaksUrl={waveformKey ? `/api/media/${waveformKey}` : null}
          posterUrl={posterKey ? `/api/media/${posterKey}` : null}
        />
      ) : (
        <PipelineStateCard
          ingestError={data.ingestError}
          sourceId={data.id}
          status={data.status}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt className="text-muted-foreground text-xs uppercase tracking-wide">
                  {fact.label}
                </dt>
                <dd className="text-sm">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
