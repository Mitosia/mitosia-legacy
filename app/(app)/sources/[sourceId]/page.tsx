import { and, desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import type {
  HighlightExtraction,
  HighlightsRun,
} from "@/components/sources/highlights-panel";
import { RefreshPoller } from "@/components/sources/refresh-poller";
import { RetryIngestButton } from "@/components/sources/retry-ingest-button";
import type { SourceMapAnalysis } from "@/components/sources/source-map";
import { SourceWorkspace } from "@/components/sources/source-workspace";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isEmbeddingConfigured } from "@/lib/ai/embeddings/provider";
import { isStalledAnalysis, scheduleAnalysisReap } from "@/lib/analysis/reaper";
import {
  project,
  source,
  sourceAnalysis,
  sourceArtifact,
  sourceChapter,
  sourceExtraction,
  sourceExtractionRun,
  sourceIndex,
  transcript,
  transcriptRevision,
} from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { formatBytes, formatDuration } from "@/lib/format";
import { ingestStepLabel, SOURCE_STATUS_LABELS } from "@/lib/ingest-labels";
import {
  isStalledExtraction,
  scheduleExtractionReap,
} from "@/lib/intelligence/extract-reaper";
import { scheduleSourceIndexBackfill } from "@/lib/intelligence/index-enqueue";
import {
  isStalledSourceIndex,
  scheduleSourceIndexReap,
} from "@/lib/intelligence/index-reaper";
import { listRecentQuestions } from "@/lib/intelligence/qa";
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
  currentRevision: { revision: number; storageKey: string } | null;
  transcript: { speakerLabels: unknown } | null;
}): {
  revision: number;
  speakerLabels: Record<string, string> | null;
  url: string;
} | null {
  if (!data.currentRevision) {
    return null;
  }
  return {
    revision: data.currentRevision.revision,
    speakerLabels:
      (data.transcript?.speakerLabels as Record<string, string> | null) ?? null,
    url: `/api/media/${data.currentRevision.storageKey}`,
  };
}

// The poller runs until the source AND its follow-on jobs settle; a
// missing row (no audio, or the capability unconfigured) counts as
// settled — absence is final.
function jobSettled(row: { status: string } | null): boolean {
  return !row || row.status === "ready" || row.status === "failed";
}

function pageIsSettled(data: {
  analysis: { status: string } | null;
  extractionRun: { status: string } | null;
  index: { status: string } | null;
  status: string;
  transcript: { status: string } | null;
}): boolean {
  return (
    (data.status === "ready" || data.status === "failed") &&
    jobSettled(data.transcript) &&
    jobSettled(data.analysis) &&
    jobSettled(data.index) &&
    jobSettled(data.extractionRun)
  );
}

function workspaceHighlights(data: {
  analysis: { status: string } | null;
  currentRevision: { revision: number } | null;
  extractionRun: {
    error: string | null;
    revision: number | null;
    status: string;
  } | null;
  extractions: HighlightExtraction[];
}): { extractions: HighlightExtraction[]; run: HighlightsRun } | null {
  if (!data.extractionRun) {
    // Pre-S5 sources: analysis exists but the automatic extraction chain
    // never fired for them. Surface the panel in its "missing" state so
    // the first run is one click, not a console session.
    return data.analysis?.status === "ready"
      ? {
          extractions: [],
          run: { error: null, stale: false, status: "missing" },
        }
      : null;
  }
  return {
    extractions: data.extractions,
    run: {
      error: data.extractionRun.error,
      stale:
        data.extractionRun.status === "ready" &&
        data.currentRevision !== null &&
        (data.extractionRun.revision ?? 0) < data.currentRevision.revision,
      status: data.extractionRun.status,
    },
  };
}

function workspaceAnalysis(data: {
  analysis: {
    entities: unknown;
    speakerSuggestions: unknown;
    status: string;
    summary: string | null;
    topics: unknown;
  } | null;
  chapters: SourceMapAnalysis["chapters"];
}): SourceMapAnalysis | null {
  if (data.analysis?.status !== "ready") {
    return null;
  }
  return {
    chapters: data.chapters,
    entities:
      (data.analysis.entities as SourceMapAnalysis["entities"] | null) ?? [],
    speakerSuggestions:
      (data.analysis.speakerSuggestions as
        | SourceMapAnalysis["speakerSuggestions"]
        | null) ?? [],
    summary: data.analysis.summary,
    topics: (data.analysis.topics as string[] | null) ?? [],
  };
}

// Opportunistic maintenance from this page's own query results (the
// reaper-scheduling pattern): stalled follow-on jobs get reaped, and a
// ready transcript with no index row (a pre-S5 source) or an index built
// from an older revision (a correction landed) gets re-enqueued.
// pending/processing/failed index rows are left alone — failed means a
// human should look, not a loop.
function scheduleSourceMaintenance(
  organizationId: string,
  data: {
    analysis: { stalled: boolean } | null;
    currentRevision: { revision: number } | null;
    extractionRun: { stalled: boolean } | null;
    id: string;
    index: { revision: number | null; stalled: boolean; status: string } | null;
    transcript: { stalled: boolean } | null;
  }
): void {
  if (data.transcript?.stalled) {
    scheduleTranscriptionReap(organizationId);
  }
  if (data.analysis?.stalled) {
    scheduleAnalysisReap(organizationId);
  }
  if (data.index?.stalled) {
    scheduleSourceIndexReap(organizationId);
  }
  if (data.extractionRun?.stalled) {
    scheduleExtractionReap(organizationId);
  }
  if (
    data.currentRevision &&
    indexNeedsBackfill(data.index, data.currentRevision.revision) &&
    isEmbeddingConfigured()
  ) {
    scheduleSourceIndexBackfill({ organizationId, sourceId: data.id });
  }
}

function indexNeedsBackfill(
  index: { revision: number | null; status: string } | null,
  currentRevision: number
): boolean {
  if (index === null) {
    return true;
  }
  return index.status === "ready" && (index.revision ?? 0) < currentRevision;
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

    const [analysisRow] = await tx
      .select({
        entities: sourceAnalysis.entities,
        id: sourceAnalysis.id,
        speakerSuggestions: sourceAnalysis.speakerSuggestions,
        stalled: sql<boolean>`(${isStalledAnalysis})`,
        status: sourceAnalysis.status,
        summary: sourceAnalysis.summary,
        topics: sourceAnalysis.topics,
      })
      .from(sourceAnalysis)
      .where(eq(sourceAnalysis.sourceId, sourceRow.id))
      .limit(1);

    const [indexRow] = await tx
      .select({
        revision: sourceIndex.revision,
        stalled: sql<boolean>`(${isStalledSourceIndex})`,
        status: sourceIndex.status,
      })
      .from(sourceIndex)
      .where(eq(sourceIndex.sourceId, sourceRow.id))
      .limit(1);

    const [extractionRunRow] = await tx
      .select({
        error: sourceExtractionRun.error,
        revision: sourceExtractionRun.revision,
        stalled: sql<boolean>`(${isStalledExtraction})`,
        status: sourceExtractionRun.status,
      })
      .from(sourceExtractionRun)
      .where(eq(sourceExtractionRun.sourceId, sourceRow.id))
      .limit(1);

    // Only grounded rows reach the UI — the aligner's gate is the whole
    // point of the provenance model.
    const extractions =
      extractionRunRow?.status === "ready"
        ? ((await tx
            .select({
              classification: sourceExtraction.classification,
              confidence: sourceExtraction.confidence,
              endMs: sourceExtraction.endMs,
              id: sourceExtraction.id,
              kind: sourceExtraction.kind,
              payload: sourceExtraction.payload,
              speaker: sourceExtraction.speaker,
              startMs: sourceExtraction.startMs,
              text: sourceExtraction.text,
            })
            .from(sourceExtraction)
            .where(
              and(
                eq(sourceExtraction.sourceId, sourceRow.id),
                eq(sourceExtraction.grounded, true)
              )
            )
            .orderBy(sourceExtraction.startMs)) as HighlightExtraction[])
        : [];

    const chapters =
      analysisRow?.status === "ready"
        ? await tx
            .select({
              endMs: sourceChapter.endMs,
              startMs: sourceChapter.startMs,
              summary: sourceChapter.summary,
              title: sourceChapter.title,
            })
            .from(sourceChapter)
            .where(eq(sourceChapter.analysisId, analysisRow.id))
            .orderBy(sourceChapter.idx)
        : [];

    // Current revision = highest revision number (no pointer column).
    let currentRevision: { revision: number; storageKey: string } | null = null;
    if (transcriptRow?.status === "ready") {
      const [revisionRow] = await tx
        .select({
          revision: transcriptRevision.revision,
          storageKey: transcriptRevision.storageKey,
        })
        .from(transcriptRevision)
        .where(eq(transcriptRevision.transcriptId, transcriptRow.id))
        .orderBy(desc(transcriptRevision.revision))
        .limit(1);
      currentRevision = revisionRow ?? null;
    }

    return {
      ...sourceRow,
      analysis: analysisRow ?? null,
      artifacts,
      chapters,
      currentRevision,
      extractionRun: extractionRunRow ?? null,
      extractions,
      index: indexRow ?? null,
      transcript: transcriptRow ?? null,
    };
  });

  if (!data) {
    notFound();
  }

  // Ask/search ride the retrieval index; history is small and recent.
  const qaHistory =
    data.index?.status === "ready"
      ? await listRecentQuestions(organizationId, data.id, 8)
      : null;

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
  const isSettled = pageIsSettled(data);

  scheduleSourceMaintenance(organizationId, data);

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
          analysis={workspaceAnalysis(data)}
          highlights={workspaceHighlights(data)}
          hlsUrl={`/api/media/${hlsKey}`}
          peaksUrl={waveformKey ? `/api/media/${waveformKey}` : null}
          posterUrl={posterKey ? `/api/media/${posterKey}` : null}
          qa={qaHistory === null ? null : { history: qaHistory }}
          sourceId={data.id}
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
