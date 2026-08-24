"use client";

import { useActionState, useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  type AskActionState,
  askSourceAction,
  type SearchActionState,
  searchSourceAction,
} from "@/lib/actions/intelligence";
import type { QuestionHistoryItem } from "@/lib/intelligence/qa";

// Ask & search (S5): one card, two modes over the same retrieval index.
// Ask synthesizes an answer with VERIFIED citations — each chip seeks and
// plays its span, which is the S5 exit test ("playable timestamped
// evidence"). Search returns raw ranked chunks for paraphrase lookups the
// transcript panel's exact-text search can't serve. Honest misses render
// as an explicit "not discussed", never an empty answer.

type Mode = "ask" | "search";

interface Citation {
  endMs: number;
  quote: string;
  startMs: number;
}

type PlayHandler = (event: React.MouseEvent<HTMLButtonElement>) => void;

function stamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function AnswerBlock({
  answer,
  answerable,
  citations,
  onPlay,
  question,
}: {
  answer: string;
  answerable: boolean;
  citations: Citation[];
  onPlay: PlayHandler;
  question: string;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="qa-answer">
      <p className="text-muted-foreground text-xs">Q: {question}</p>
      {answerable ? (
        <p className="text-sm">{answer}</p>
      ) : (
        <p className="text-muted-foreground text-sm" data-testid="qa-no-answer">
          {answer}
        </p>
      )}
      {citations.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {citations.map((citation) => (
            <button
              className="flex max-w-full cursor-pointer items-baseline gap-1.5 rounded-md border px-2 py-1 text-left hover:bg-muted"
              data-start-ms={citation.startMs}
              data-testid="qa-citation"
              key={`${citation.startMs}-${citation.endMs}`}
              onClick={onPlay}
              type="button"
            >
              <span className="text-muted-foreground text-xs tabular-nums">
                {stamp(citation.startMs)}
              </span>
              <span className="truncate text-xs">“{citation.quote}”</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AskMode({
  history,
  onPlay,
  sourceId,
}: {
  history: QuestionHistoryItem[];
  onPlay: PlayHandler;
  sourceId: string;
}) {
  const [shownHistory, setShownHistory] = useState<QuestionHistoryItem | null>(
    null
  );
  const [state, formAction, pending] = useActionState<AskActionState, FormData>(
    askSourceAction,
    {}
  );

  const submit = useCallback(
    (formData: FormData) => {
      setShownHistory(null);
      formData.set("sourceId", sourceId);
      formAction(formData);
    },
    [sourceId, formAction]
  );
  const showHistoryItem = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const { historyId } = event.currentTarget.dataset;
      setShownHistory(history.find((item) => item.id === historyId) ?? null);
    },
    [history]
  );

  const answer = shownHistory
    ? {
        answer: shownHistory.answer ?? "",
        answerable: shownHistory.answerable ?? false,
        citations: shownHistory.citations,
        question: shownHistory.question,
      }
    : state.result;

  return (
    <div className="flex flex-col gap-3">
      <form action={submit} className="flex gap-2">
        <Input
          data-testid="ask-input"
          disabled={pending}
          maxLength={500}
          name="question"
          placeholder="What does the guest say about…?"
          required
        />
        <Button data-testid="ask-submit" disabled={pending} type="submit">
          {pending ? "Answering…" : "Ask"}
        </Button>
      </form>
      {state.error ? (
        <p className="text-destructive text-sm">{state.error}</p>
      ) : null}
      {answer ? (
        <AnswerBlock
          answer={answer.answer}
          answerable={answer.answerable}
          citations={answer.citations}
          onPlay={onPlay}
          question={answer.question}
        />
      ) : null}
      {history.length > 0 ? (
        <div className="flex flex-col gap-1 border-t pt-2">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            Recent questions
          </p>
          {history.map((item) => (
            <button
              className="cursor-pointer rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
              data-history-id={item.id}
              data-testid="qa-history-item"
              key={item.id}
              onClick={showHistoryItem}
              type="button"
            >
              {item.question}
              {item.answerable === false ? (
                <Badge className="ml-2" variant="outline">
                  Not discussed
                </Badge>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SearchMode({
  onPlay,
  sourceId,
}: {
  onPlay: PlayHandler;
  sourceId: string;
}) {
  const [state, formAction, pending] = useActionState<
    SearchActionState,
    FormData
  >(searchSourceAction, {});
  const submit = useCallback(
    (formData: FormData) => {
      formData.set("sourceId", sourceId);
      formAction(formData);
    },
    [sourceId, formAction]
  );

  return (
    <div className="flex flex-col gap-3">
      <form action={submit} className="flex gap-2">
        <Input
          data-testid="search-input"
          disabled={pending}
          maxLength={200}
          name="query"
          placeholder="Find a moment by meaning, not exact words"
          required
        />
        <Button
          data-testid="search-submit"
          disabled={pending}
          type="submit"
          variant="secondary"
        >
          {pending ? "Searching…" : "Search"}
        </Button>
      </form>
      {state.error ? (
        <p className="text-destructive text-sm">{state.error}</p>
      ) : null}
      {state.results ? (
        <ol className="flex flex-col">
          {state.results.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No matching moments.
            </p>
          ) : null}
          {state.results.map((result) => (
            <li key={`${result.startMs}-${result.endMs}`}>
              <button
                className="flex w-full cursor-pointer items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                data-start-ms={result.startMs}
                data-testid="search-result"
                onClick={onPlay}
                type="button"
              >
                <span className="text-muted-foreground text-xs tabular-nums">
                  {stamp(result.startMs)}
                </span>
                <span className="line-clamp-2 flex-1 text-sm">
                  {result.snippet}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function AskPanel({
  history,
  sourceId,
  video,
}: {
  history: QuestionHistoryItem[];
  sourceId: string;
  video: HTMLVideoElement | null;
}) {
  const [mode, setMode] = useState<Mode>("ask");

  const onPlay = useCallback<PlayHandler>(
    (event) => {
      const startMs = Number(event.currentTarget.dataset.startMs);
      if (video && Number.isFinite(startMs)) {
        video.currentTime = startMs / 1000;
        video.play().catch(() => {
          // Autoplay policies can refuse; the seek alone still lands
        });
      }
    },
    [video]
  );

  const onModeChange = useCallback((groupValue: unknown[]) => {
    const next = groupValue.at(0);
    if (next === "ask" || next === "search") {
      setMode(next);
    }
  }, []);

  return (
    <Card data-testid="ask-panel">
      <CardHeader>
        <CardTitle>Ask this source</CardTitle>
        <CardDescription>
          Answers come only from this recording, with playable evidence.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ToggleGroup
          onValueChange={onModeChange}
          size="sm"
          value={[mode]}
          variant="outline"
        >
          <ToggleGroupItem data-testid="mode-ask" value="ask">
            Ask
          </ToggleGroupItem>
          <ToggleGroupItem data-testid="mode-search" value="search">
            Search
          </ToggleGroupItem>
        </ToggleGroup>
        {mode === "ask" ? (
          <AskMode history={history} onPlay={onPlay} sourceId={sourceId} />
        ) : (
          <SearchMode onPlay={onPlay} sourceId={sourceId} />
        )}
      </CardContent>
    </Card>
  );
}
