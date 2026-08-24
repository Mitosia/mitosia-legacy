"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type HighlightExtraction,
  HighlightsPanel,
  type HighlightsRun,
} from "./highlights-panel";
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
  peaksUrl: string | null;
  posterUrl: string | null;
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
  peaksUrl,
  posterUrl,
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
