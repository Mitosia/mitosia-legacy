"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SourcePlayer } from "./source-player";
import { TranscriptPanel } from "./transcript-panel";

// Client composition root for the source page: the player hands its media
// element up, the transcript panel drives it (click-to-seek) and follows it
// (active word). Nothing here owns media state — the element is the single
// source of truth, per the player's passive-consumer contract.

interface SourceWorkspaceProps {
  hlsUrl: string;
  peaksUrl: string | null;
  posterUrl: string | null;
  transcript: {
    speakerLabels: Record<string, string> | null;
    url: string;
  } | null;
}

export function SourceWorkspace({
  hlsUrl,
  peaksUrl,
  posterUrl,
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
      {transcript ? (
        <Card data-testid="transcript-card" data-transcript-status="ready">
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
          </CardHeader>
          <CardContent>
            <TranscriptPanel
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
