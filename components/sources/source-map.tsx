"use client";

import { useRouter } from "next/navigation";
import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { updateSpeakerLabelsAction } from "@/lib/actions/transcripts";

// Source map v1: the analysis rendered as navigation — executive summary,
// clickable chapters (seek the same media element the transcript drives),
// topic/entity chips — plus the speaker-intelligence banner: AI-suggested
// names/merges as CONFIRMED suggestions (AGENTS.md §Transcription), where
// Apply drives the exact same speaker_labels action as the manual dialog.

export interface SourceMapChapter {
  endMs: number;
  startMs: number;
  summary: string | null;
  title: string;
}

export interface SpeakerSuggestion {
  confidence: number;
  evidence: string;
  mergeWith: string | null;
  speaker: string;
  suggestedName: string | null;
}

export interface SourceMapAnalysis {
  chapters: SourceMapChapter[];
  entities: { name: string; type: string }[];
  speakerSuggestions: SpeakerSuggestion[];
  summary: string | null;
  topics: string[];
}

function chapterStamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

// Suggested labels including merge resolution: a speaker with mergeWith
// inherits the name suggested for (or already applied to) its target, so
// applying the suggestions performs the same-name merge in one step.
export function suggestedLabels(
  suggestions: SpeakerSuggestion[],
  existing: Record<string, string> | null
): Record<string, string> {
  const labels: Record<string, string> = { ...(existing ?? {}) };
  for (const suggestion of suggestions) {
    if (suggestion.suggestedName && !labels[suggestion.speaker]) {
      labels[suggestion.speaker] = suggestion.suggestedName;
    }
  }
  for (const suggestion of suggestions) {
    if (suggestion.mergeWith !== null) {
      const target =
        labels[suggestion.mergeWith] ??
        suggestions.find((s) => s.speaker === suggestion.mergeWith)
          ?.suggestedName;
      if (target) {
        labels[suggestion.speaker] = target;
      }
    }
  }
  return labels;
}

export function SpeakerSuggestionBanner({
  sourceId,
  speakerLabels,
  suggestions,
}: {
  sourceId: string;
  speakerLabels: Record<string, string> | null;
  suggestions: SpeakerSuggestion[];
}) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);
  const [state, formAction, pending] = useActionState(
    updateSpeakerLabelsAction,
    {}
  );
  useEffect(() => {
    if (state.success) {
      router.refresh();
    }
  }, [state.success, router]);

  const labels = useMemo(
    () => suggestedLabels(suggestions, speakerLabels),
    [suggestions, speakerLabels]
  );
  // Only offer what would actually change something
  const additions = useMemo(
    () =>
      Object.entries(labels).filter(
        ([speaker, name]) => speakerLabels?.[speaker] !== name
      ),
    [labels, speakerLabels]
  );

  const dismiss = useCallback(() => setDismissed(true), []);
  const submit = useCallback(
    (formData: FormData) => {
      formData.set("labels", JSON.stringify(labels));
      formData.set("sourceId", sourceId);
      formAction(formData);
    },
    [labels, sourceId, formAction]
  );

  if (dismissed || state.success || additions.length === 0) {
    return null;
  }

  return (
    <Card data-testid="speaker-suggestions">
      <CardHeader>
        <CardTitle className="text-base">Suggested speaker names</CardTitle>
        <CardDescription>
          Inferred from the conversation — nothing is applied until you confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        {additions.map(([speaker, name]) => (
          <Badge key={speaker} variant="secondary">
            Speaker {Number(speaker) + 1} → {name}
          </Badge>
        ))}
        <form action={submit} className="ml-auto flex gap-2">
          <Button
            disabled={pending}
            onClick={dismiss}
            size="sm"
            type="button"
            variant="outline"
          >
            Dismiss
          </Button>
          <Button
            data-testid="apply-speaker-suggestions"
            disabled={pending}
            size="sm"
            type="submit"
          >
            Apply
          </Button>
        </form>
        {state.error ? (
          <p className="text-destructive text-sm">{state.error}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SourceMap({
  analysis,
  video,
}: {
  analysis: SourceMapAnalysis;
  video: HTMLVideoElement | null;
}) {
  const seekTo = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const startMs = Number(event.currentTarget.dataset.startMs);
      if (video && Number.isFinite(startMs)) {
        video.currentTime = startMs / 1000;
      }
    },
    [video]
  );

  return (
    <Card data-testid="source-map">
      <CardHeader>
        <CardTitle>Source map</CardTitle>
        {analysis.summary ? (
          <CardDescription data-testid="analysis-summary">
            {analysis.summary}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {analysis.topics.length > 0 || analysis.entities.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {analysis.topics.map((topic) => (
              <Badge key={`topic-${topic}`} variant="secondary">
                {topic}
              </Badge>
            ))}
            {analysis.entities.map((entity) => (
              <Badge key={`entity-${entity.name}`} variant="outline">
                {entity.name}
              </Badge>
            ))}
          </div>
        ) : null}
        {analysis.chapters.length > 0 ? (
          <ol className="flex flex-col">
            {analysis.chapters.map((chapter) => (
              <li key={`${chapter.startMs}-${chapter.title}`}>
                <button
                  className="flex w-full cursor-pointer items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  data-start-ms={chapter.startMs}
                  data-testid="chapter-item"
                  onClick={seekTo}
                  type="button"
                >
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {chapterStamp(chapter.startMs)}
                  </span>
                  <span className="flex-1">
                    <span className="block font-medium text-sm">
                      {chapter.title}
                    </span>
                    {chapter.summary ? (
                      <span className="block text-muted-foreground text-xs">
                        {chapter.summary}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        ) : null}
      </CardContent>
    </Card>
  );
}
