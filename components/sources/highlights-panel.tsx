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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { rerunExtractionAction } from "@/lib/actions/intelligence";
import { speakerDisplayName } from "@/lib/transcription/paragraphs";

// Highlights v1 (S5): the grounded extraction rows rendered as one
// filterable list — quotes, stories, claims, Q&A exchanges — each a seek
// button into the same media element the chapters drive. One surface, not
// per-kind tabs (plan decision: a strategist doesn't browse by extraction
// taxonomy). Every row here passed the grounding aligner, so its range is
// word-snapped and playable by construction.

export type HighlightKind = "claim" | "qa" | "quote" | "story";

export interface HighlightExtraction {
  classification: "direct_quote" | "paraphrase" | null;
  confidence: number;
  endMs: number;
  id: string;
  kind: HighlightKind;
  payload: {
    answerStartMs?: number;
    statement?: string;
    title?: string;
  } | null;
  speaker: string | null;
  startMs: number;
  text: string;
}

export interface HighlightsRun {
  error: string | null;
  // Current transcript revision is newer than the one extracted from
  stale: boolean;
  status: string;
}

const KIND_LABELS: Record<HighlightKind, string> = {
  claim: "Claim",
  qa: "Q&A",
  quote: "Quote",
  story: "Story",
};
const KIND_ORDER: HighlightKind[] = ["quote", "story", "claim", "qa"];

function stamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function primaryLine(extraction: HighlightExtraction): string {
  if (extraction.kind === "story") {
    return extraction.payload?.title ?? extraction.text;
  }
  if (extraction.kind === "qa") {
    return extraction.payload?.statement ?? extraction.text;
  }
  if (extraction.kind === "claim") {
    return extraction.payload?.statement ?? extraction.text;
  }
  return extraction.text;
}

function secondaryLine(extraction: HighlightExtraction): string | null {
  if (extraction.kind === "story") {
    return extraction.payload?.statement ?? null;
  }
  if (extraction.kind === "qa" || extraction.kind === "claim") {
    return extraction.text;
  }
  return null;
}

export function RerunExtractionButton({
  label = "Run extraction again",
  sourceId,
}: {
  label?: string;
  sourceId: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    rerunExtractionAction,
    {}
  );
  useEffect(() => {
    if (state.success) {
      router.refresh();
    }
  }, [state.success, router]);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input name="sourceId" type="hidden" value={sourceId} />
      <Button
        data-testid="rerun-extraction"
        disabled={pending}
        size="sm"
        type="submit"
        variant="outline"
      >
        {pending ? "Starting…" : label}
      </Button>
      {state.error ? (
        <p className="text-destructive text-sm">{state.error}</p>
      ) : null}
    </form>
  );
}

export function HighlightsPanel({
  extractions,
  run,
  sourceId,
  speakerLabels,
  video,
}: {
  extractions: HighlightExtraction[];
  run: HighlightsRun;
  sourceId: string;
  speakerLabels: Record<string, string> | null;
  video: HTMLVideoElement | null;
}) {
  const [filter, setFilter] = useState<HighlightKind | "all">("all");

  const counts = useMemo(() => {
    const byKind = new Map<HighlightKind, number>();
    for (const extraction of extractions) {
      byKind.set(extraction.kind, (byKind.get(extraction.kind) ?? 0) + 1);
    }
    return byKind;
  }, [extractions]);

  const visible = useMemo(
    () =>
      filter === "all"
        ? extractions
        : extractions.filter((extraction) => extraction.kind === filter),
    [extractions, filter]
  );

  const seekTo = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const startMs = Number(event.currentTarget.dataset.startMs);
      if (video && Number.isFinite(startMs)) {
        video.currentTime = startMs / 1000;
      }
    },
    [video]
  );

  const onFilterChange = useCallback((groupValue: unknown[]) => {
    const next = groupValue.at(0);
    setFilter(
      typeof next === "string" && next.length > 0
        ? (next as HighlightKind | "all")
        : "all"
    );
  }, []);

  if (run.status === "missing") {
    return (
      <Card data-testid="highlights-panel">
        <CardHeader>
          <CardTitle>Highlights</CardTitle>
          <CardDescription>
            Extract quotes, stories, claims, and Q&A from this recording — each
            grounded to its exact moment.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RerunExtractionButton label="Find highlights" sourceId={sourceId} />
        </CardContent>
      </Card>
    );
  }

  if (run.status === "pending" || run.status === "processing") {
    return (
      <Card data-testid="highlights-panel">
        <CardHeader>
          <CardTitle>Highlights</CardTitle>
          <CardDescription>
            Finding quotes, stories, claims, and Q&A… This page updates
            automatically.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (run.status === "failed") {
    return (
      <Card data-testid="highlights-panel">
        <CardHeader>
          <CardTitle>Highlights</CardTitle>
          <CardDescription>
            Extraction failed. You can run it again.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {run.error ? (
            <p className="break-words text-muted-foreground text-xs">
              {run.error}
            </p>
          ) : null}
          <RerunExtractionButton sourceId={sourceId} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="highlights-panel">
      <CardHeader>
        <CardTitle>Highlights</CardTitle>
        <CardDescription>
          {extractions.length > 0
            ? "Grounded moments extracted from the transcript — click to play."
            : "Nothing extraction-worthy was found in this recording."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {run.stale ? (
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
            <span>The transcript changed since these were extracted.</span>
            <RerunExtractionButton sourceId={sourceId} />
          </div>
        ) : null}
        {extractions.length > 0 ? (
          <ToggleGroup
            onValueChange={onFilterChange}
            size="sm"
            value={[filter]}
            variant="outline"
          >
            <ToggleGroupItem data-testid="highlight-filter-all" value="all">
              All ({extractions.length})
            </ToggleGroupItem>
            {KIND_ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map(
              (kind) => (
                <ToggleGroupItem
                  data-testid={`highlight-filter-${kind}`}
                  key={kind}
                  value={kind}
                >
                  {KIND_LABELS[kind]}s ({counts.get(kind)})
                </ToggleGroupItem>
              )
            )}
          </ToggleGroup>
        ) : null}
        {visible.length > 0 ? (
          <ol className="flex flex-col">
            {visible.map((extraction) => (
              <li key={extraction.id}>
                <button
                  className="flex w-full cursor-pointer items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  data-start-ms={extraction.startMs}
                  data-testid="highlight-item"
                  onClick={seekTo}
                  type="button"
                >
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {stamp(extraction.startMs)}
                  </span>
                  <span className="flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">
                        {KIND_LABELS[extraction.kind]}
                      </Badge>
                      {extraction.classification ? (
                        <Badge variant="outline">
                          {extraction.classification === "direct_quote"
                            ? "Direct quote"
                            : "Paraphrase"}
                        </Badge>
                      ) : null}
                      <span className="text-muted-foreground text-xs">
                        {speakerDisplayName(extraction.speaker, speakerLabels)}
                      </span>
                    </span>
                    <span className="block text-sm">
                      {extraction.kind === "qa" ? "Q: " : null}
                      {primaryLine(extraction)}
                    </span>
                    {secondaryLine(extraction) ? (
                      <span className="line-clamp-2 block text-muted-foreground text-xs">
                        {secondaryLine(extraction)}
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
