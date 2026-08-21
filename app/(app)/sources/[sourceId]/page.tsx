import { desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { RefreshPoller } from "@/components/sources/refresh-poller";
import { RetryIngestButton } from "@/components/sources/retry-ingest-button";
import { SourceWorkspace } from "@/components/sources/source-workspace";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  project,
  source,
  sourceArtifact,
  transcript,
  transcriptRevision,
} from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { formatBytes, formatDuration } from "@/lib/format";
import { ingestStepLabel, SOURCE_STATUS_LABELS } from "@/lib/ingest-labels";
import { requireOrg } from "@/lib/org";
import {
  isStalledTranscription,
  scheduleTranscriptionReap,
} from "@/lib/transcription/reaper";

const TRANSCRIPT_STATUS_LABELS: Record<string, string> = {
  failed: "Transcription failed",
  pending: "Transcription queued",
  processing: "Transcribing",
  ready: "Transcript ready",
};

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
        <CardTitle>
          {failed
            ? "Couldn't prepare this recording"
            : "Preparing your recording"}
        </CardTitle>
        <CardDescription>
          {failed
            ? "Something went wrong while processing it. You can retry, or upload the file again."
            : "It will be ready to play and edit shortly. This page updates automatically."}
        </CardDescription>
      </CardHeader>
      {failed ? (
        <CardContent className="space-y-2">
          {ingestError ? (
            <p
              className="break-words text-muted-foreground text-xs"
              data-testid="ingest-error"
            >
              {ingestError}
            </p>
          ) : null}
          <RetryIngestButton sourceId={sourceId} />
        </CardContent>
      ) : null}
    </Card>
  );
}

function TranscriptStatusCard({
  transcript: transcriptRow,
}: {
  transcript: { error: string | null; language: string | null; status: string };
}) {
  return (
    <Card data-testid="transcript-card">
      <CardHeader>
        <CardTitle>Transcript</CardTitle>
        <CardDescription>
          <span data-transcript-status={transcriptRow.status}>
            {TRANSCRIPT_STATUS_LABELS[transcriptRow.status] ??
              transcriptRow.status}
          </span>
          {transcriptRow.language ? ` · ${transcriptRow.language}` : null}
        </CardDescription>
      </CardHeader>
      {transcriptRow.status === "failed" && transcriptRow.error ? (
        <CardContent>
          <p
            className="break-words text-muted-foreground text-xs"
            data-testid="transcript-error"
          >
            {transcriptRow.error}
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

function workspaceTranscript(data: {
  transcript: { speakerLabels: unknown } | null;
  transcriptKey: string | null;
}): { speakerLabels: Record<string, string> | null; url: string } | null {
  if (!data.transcriptKey) {
    return null;
  }
  return {
    speakerLabels:
      (data.transcript?.speakerLabels as Record<string, string> | null) ?? null,
    url: `/api/media/${data.transcriptKey}`,
  };
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

    const [transcriptRow] = await tx
      .select({
        error: transcript.error,
        id: transcript.id,
        language: transcript.language,
        speakerLabels: transcript.speakerLabels,
        // Staleness evaluated in the database, same as the ingest reaper
        stalled: sql<boolean>`(${isStalledTranscription})`,
        status: transcript.status,
      })
      .from(transcript)
      .where(eq(transcript.sourceId, sourceRow.id))
      .limit(1);

    // Current revision = highest revision number (no pointer column).
    let transcriptKey: string | null = null;
    if (transcriptRow?.status === "ready") {
      const [revisionRow] = await tx
        .select({ storageKey: transcriptRevision.storageKey })
        .from(transcriptRevision)
        .where(eq(transcriptRevision.transcriptId, transcriptRow.id))
        .orderBy(desc(transcriptRevision.revision))
        .limit(1);
      transcriptKey = revisionRow?.storageKey ?? null;
    }

    return {
      ...sourceRow,
      artifacts,
      transcript: transcriptRow ?? null,
      transcriptKey,
    };
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
  // The transcript arrives after "ready", so the poller keeps running until
  // it settles too. A source with no transcript row (no audio, or
  // transcription unconfigured) counts as settled — absence is final.
  const transcriptSettled =
    !data.transcript ||
    data.transcript.status === "ready" ||
    data.transcript.status === "failed";
  const isSettled =
    (data.status === "ready" || data.status === "failed") && transcriptSettled;

  if (data.transcript?.stalled) {
    scheduleTranscriptionReap(organizationId);
  }

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
            {data.status === "processing"
              ? `${ingestStepLabel(data.ingestStep)}…`
              : SOURCE_STATUS_LABELS[data.status]}
          </Badge>
        )}
      </div>

      {data.status === "ready" && hlsKey ? (
        <SourceWorkspace
          hlsUrl={`/api/media/${hlsKey}`}
          peaksUrl={waveformKey ? `/api/media/${waveformKey}` : null}
          posterUrl={posterKey ? `/api/media/${posterKey}` : null}
          transcript={workspaceTranscript(data)}
        />
      ) : (
        <PipelineStateCard
          ingestError={data.ingestError}
          sourceId={data.id}
          status={data.status}
        />
      )}

      {data.transcript && data.transcript.status !== "ready" ? (
        <TranscriptStatusCard transcript={data.transcript} />
      ) : null}

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
