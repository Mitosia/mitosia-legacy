"use client";

import { useCallback, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  SegmentsPanel,
  type SegmentsRun,
  type SegmentView,
} from "./segments-panel";
import {
  SourceMap,
  type SourceMapAnalysis,
  SpeakerSuggestionBanner,
} from "./source-map";
import { SourcePlayer } from "./source-player";
import { TranscriptPanel } from "./transcript-panel";
import { type RangePlayback, useRangePlayback } from "./use-range-playback";

// Client composition root for the source page: a two-pane workspace. The
// player stays pinned in the left pane (sticky on wide screens) while the
// review sections live in a tabbed right sidebar — clicking a moment deep
// in a list must never require scrolling back up to see the video. The
// player hands its media element up; panels drive it through one shared
// useRangePlayback instance (span playback pauses at the out-point) and
// follow it (active word). Nothing here owns media state — the element is
// the single source of truth, per the player's passive-consumer contract.
//
// Tabs are keepMounted so the poller's refreshes and tab flips never drop
// panel state (an in-flight Ask answer, transcript scroll), and so
// attribute-based e2e/DOM contracts (data-transcript-status) stay resolvable
// regardless of the active tab. Panels render into existence as their jobs
// settle; until the user picks a tab, the first available one is active.

export interface SourceFact {
  label: string;
  value: string;
}

interface SourceWorkspaceProps {
  analysis: SourceMapAnalysis | null;
  facts: SourceFact[];
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
  segments: {
    run: SegmentsRun;
    segments: SegmentView[];
  } | null;
  sourceId: string;
  transcript: {
    revision: number;
    speakerLabels: Record<string, string> | null;
    url: string;
  } | null;
}

type WorkspaceTab =
  | "ask"
  | "highlights"
  | "moments"
  | "overview"
  | "segments"
  | "transcript";

const TAB_LABELS: Record<WorkspaceTab, string> = {
  ask: "Ask",
  highlights: "Highlights",
  moments: "Moments",
  overview: "Overview",
  segments: "Segments",
  transcript: "Transcript",
};

interface WorkspaceSection {
  content: React.ReactNode;
  tab: WorkspaceTab;
}

// Source facts (duration, size, codecs, original filename). Rendered in the
// workspace's left column on wide screens, after the tabs on small ones, and
// standalone by the page while the source is still processing.
export function SourceDetailsCard({
  className,
  facts,
}: {
  className?: string;
  facts: SourceFact[];
}) {
  return (
    <Card className={className} data-testid="source-details">
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
  );
}

// Sections in review-priority order; each exists only once its job (or the
// job before it) has something to show.
function buildSections(
  {
    analysis,
    highlights,
    index,
    moments,
    qa,
    segments,
    sourceId,
    transcript,
  }: SourceWorkspaceProps,
  playback: RangePlayback,
  video: HTMLVideoElement | null
): WorkspaceSection[] {
  const sections: WorkspaceSection[] = [];
  const transcriptUrl = transcript ? transcript.url : null;
  if (moments) {
    sections.push({
      content: (
        <MomentsPanel
          candidates={moments.candidates}
          playback={playback}
          run={moments.run}
          sourceId={sourceId}
          transcriptUrl={transcriptUrl}
        />
      ),
      tab: "moments",
    });
  }
  if (segments) {
    sections.push({
      content: (
        <SegmentsPanel
          playback={playback}
          run={segments.run}
          segments={segments.segments}
          sourceId={sourceId}
          transcriptUrl={transcriptUrl}
        />
      ),
      tab: "segments",
    });
  }
  if (highlights) {
    sections.push({
      content: (
        <HighlightsPanel
          extractions={highlights.extractions}
          playback={playback}
          run={highlights.run}
          sourceId={sourceId}
          speakerLabels={transcript?.speakerLabels ?? null}
        />
      ),
      tab: "highlights",
    });
  }
  if (analysis) {
    sections.push({
      content: <SourceMap analysis={analysis} video={video} />,
      tab: "overview",
    });
  }
  if (qa) {
    sections.push({
      content: (
        <AskPanel
          history={qa.history}
          playback={playback}
          sourceId={sourceId}
        />
      ),
      tab: "ask",
    });
  } else if (index) {
    sections.push({
      content: <IndexStatusCard index={index} sourceId={sourceId} />,
      tab: "ask",
    });
  }
  if (transcript) {
    sections.push({
      content: (
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
      ),
      tab: "transcript",
    });
  }
  return sections;
}

function WorkspaceSidebar({
  activeTab,
  onTabChange,
  sections,
}: {
  activeTab: WorkspaceTab;
  onTabChange: (value: unknown) => void;
  sections: WorkspaceSection[];
}) {
  return (
    <Tabs
      className="lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)]"
      onValueChange={onTabChange}
      value={activeTab}
    >
      <TabsList
        className="h-auto w-full shrink-0 flex-wrap justify-start"
        data-testid="workspace-tabs"
      >
        {sections.map((section) => (
          <TabsTrigger
            data-testid={`workspace-tab-${section.tab}`}
            key={section.tab}
            value={section.tab}
          >
            {TAB_LABELS[section.tab]}
          </TabsTrigger>
        ))}
      </TabsList>
      {sections.map((section) => (
        <TabsContent
          className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:p-px lg:[&>*]:min-h-full"
          keepMounted
          key={section.tab}
          value={section.tab}
        >
          {section.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function SourceWorkspace(props: SourceWorkspaceProps) {
  const { analysis, facts, hlsUrl, peaksUrl, posterUrl, sourceId, transcript } =
    props;
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const playback = useRangePlayback(video);
  // The user's explicit choice; until they make one, the first available
  // tab is active (sections appear as their follow-on jobs settle).
  const [chosenTab, setChosenTab] = useState<WorkspaceTab | null>(null);

  const sections = buildSections(props, playback, video);
  const chosen = sections.find((section) => section.tab === chosenTab);
  const activeTab = chosen?.tab ?? sections[0]?.tab ?? null;

  const onTabChange = useCallback((value: unknown) => {
    if (typeof value === "string" && value in TAB_LABELS) {
      setChosenTab(value as WorkspaceTab);
    }
  }, []);

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
      {/* p-px on both scroll containers: a card border sitting exactly on
          the overflow clip edge disappears; one pixel of inset keeps every
          border visible. */}
      <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:p-px">
        <SourcePlayer
          hlsUrl={hlsUrl}
          onVideoElement={setVideo}
          peaksUrl={peaksUrl}
          posterUrl={posterUrl}
        />
        {analysis && transcript ? (
          <SpeakerSuggestionBanner
            sourceId={sourceId}
            speakerLabels={transcript.speakerLabels}
            suggestions={analysis.speakerSuggestions}
          />
        ) : null}
        <SourceDetailsCard className="hidden lg:block" facts={facts} />
      </div>
      {activeTab ? (
        <WorkspaceSidebar
          activeTab={activeTab}
          onTabChange={onTabChange}
          sections={sections}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Understanding this recording</CardTitle>
            <CardDescription>
              Transcript, highlights, and moments appear here as they finish.
              This page updates automatically.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
      <SourceDetailsCard className="lg:hidden" facts={facts} />
    </div>
  );
}
