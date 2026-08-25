"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { QuestionHistoryItem } from "@/lib/intelligence/qa";
import { AskPanel } from "./ask-panel";
import {
  type HighlightExtraction,
  HighlightsPanel,
  type HighlightsRun,
} from "./highlights-panel";
import { type IndexStatus, IndexStatusCard } from "./index-status-card";
import {
  type MomentCandidateView,
  MomentsPanel,
  type MomentsRun,
} from "./moments-panel";
import {
  SourceMap,
  type SourceMapAnalysis,
  SpeakerSuggestionBanner,
} from "./source-map";
import { SourcePlayer } from "./source-player";
import { TranscriptPanel } from "./transcript-panel";

// Client composition root for the source page: the player hands its media
// element up, the transcript panel drives it (click-to-seek) and follows it
// (active word). Nothing here owns media state — the element is the single
// source of truth, per the player's passive-consumer contract.

interface SourceWorkspaceProps {
  analysis: SourceMapAnalysis | null;
  highlights: {
    extractions: HighlightExtraction[];
    run: HighlightsRun;
  } | null;
  hlsUrl: string;
  // The index lifecycle row, rendered in the Ask slot while qa is null so
  // the panel's absence is explained (building) or recoverable (failed)
  index: IndexStatus | null;
  moments: {
    candidates: MomentCandidateView[];
    run: MomentsRun;
  } | null;
  peaksUrl: string | null;
  posterUrl: string | null;
  // Non-null once the retrieval index is ready — gates the Ask panel
  qa: { history: QuestionHistoryItem[] } | null;
  sourceId: string;
  transcript: {
    revision: number;
    speakerLabels: Record<string, string> | null;
    url: string;
  } | null;
}

export function SourceWorkspace({
  analysis,
  highlights,
  hlsUrl,
  index,
  moments,
  peaksUrl,
  posterUrl,
  qa,
  sourceId,
  transcript,
}: SourceWorkspaceProps) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <SourcePlayer
        hlsUrl={hlsUrl}
        onVideoElement={setVideo}
        peaksUrl={peaksUrl}
        posterUrl={posterUrl}
      />
      {analysis ? <SourceMap analysis={analysis} video={video} /> : null}
      {highlights ? (
        <HighlightsPanel
          extractions={highlights.extractions}
          run={highlights.run}
          sourceId={sourceId}
          speakerLabels={transcript?.speakerLabels ?? null}
          video={video}
        />
      ) : null}
      {moments ? (
        <MomentsPanel
          candidates={moments.candidates}
          run={moments.run}
          sourceId={sourceId}
          transcriptUrl={transcript ? transcript.url : null}
          video={video}
        />
      ) : null}
      {qa ? (
        <AskPanel history={qa.history} sourceId={sourceId} video={video} />
      ) : null}
      {!qa && index ? (
        <IndexStatusCard index={index} sourceId={sourceId} />
      ) : null}
      {analysis && transcript ? (
        <SpeakerSuggestionBanner
          sourceId={sourceId}
          speakerLabels={transcript.speakerLabels}
          suggestions={analysis.speakerSuggestions}
        />
      ) : null}
      {transcript ? (
        <Card data-testid="transcript-card" data-transcript-status="ready">
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
          </CardHeader>
          <CardContent>
            <TranscriptPanel
              editable={{ baseRevision: transcript.revision, sourceId }}
              speakerLabels={transcript.speakerLabels}
              transcriptUrl={transcript.url}
              video={video}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
