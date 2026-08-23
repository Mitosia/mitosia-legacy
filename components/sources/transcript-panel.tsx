"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChangeEvent, MouseEvent } from "react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildParagraphs,
  findParagraphIndexForWord,
  findWordIndexAtTime,
  speakerDisplayName,
  type TranscriptParagraph,
} from "@/lib/transcription/paragraphs";
import type { TranscriptData } from "@/lib/transcription/types";
import {
  CorrectWordDialog,
  SpeakerLabelsDialog,
  type WordToCorrect,
} from "./transcript-dialogs";

// Transcript viewer: virtualized paragraphs over the canonical word JSON,
// click-word-to-seek, active-word highlight during playback, search, and
// low-confidence marking. The sanctioned custom domain UI (AGENTS.md) —
// built from registry primitives, with the heavy engineering in
// lib/transcription/paragraphs.ts where it is unit-tested.
//
// Scale rules (a 2h source is 20–30k words; patterns per
// docs/editor-study.md):
// - Rows are PARAGRAPHS, not words; only ~a viewport of them is mounted.
// - Active-word updates re-render at most two paragraph rows (the one
//   losing and the one gaining the highlight) — every other row's props
//   are reference-stable, so memo() blocks the rest.
// - time → word is a binary search over the flat word array, never a scan.
// - Follow-scroll pauses when the user scrolls (wheel/touch), never
//   fighting them; "Jump to current" re-engages it.

const LOW_CONFIDENCE_THRESHOLD = 0.6;
const ROW_ESTIMATE_CHARS_PER_LINE = 90;
const ROW_ESTIMATE_LINE_HEIGHT = 24;
const ROW_ESTIMATE_CHROME = 44;

const SPEAKER_COLORS = [
  "text-indigo-600 dark:text-indigo-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-amber-600 dark:text-amber-400",
  "text-sky-600 dark:text-sky-400",
  "text-rose-600 dark:text-rose-400",
  "text-violet-600 dark:text-violet-400",
];

function speakerColorClass(speaker: string | null): string {
  const numeric = Number(speaker ?? Number.NaN);
  if (!Number.isInteger(numeric)) {
    return "text-muted-foreground";
  }
  return (
    SPEAKER_COLORS[numeric % SPEAKER_COLORS.length] ?? "text-muted-foreground"
  );
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

interface ParagraphRowProps {
  // Global index of the active word when it falls inside this paragraph,
  // -1 otherwise — the -1 keeps props reference-stable for inactive rows.
  activeWordIndex: number;
  // Global index of the focused search match when inside this paragraph
  focusedMatchIndex: number;
  onSpeakerClick: (() => void) | null;
  onWordClick: (startMs: number) => void;
  onWordDoubleClick: ((word: WordToCorrect) => void) | null;
  paragraph: TranscriptParagraph;
  searchQuery: string;
  speakerLabel: string;
}

const ParagraphRow = memo(function ParagraphRowInner({
  activeWordIndex,
  focusedMatchIndex,
  onSpeakerClick,
  onWordClick,
  onWordDoubleClick,
  paragraph,
  searchQuery,
  speakerLabel,
}: ParagraphRowProps) {
  const query = searchQuery.toLowerCase();
  // One stable handler for every word button (its identity comes from the
  // dataset), so word count never multiplies closure count.
  const handleWordClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      onWordClick(Number(event.currentTarget.dataset.startMs));
    },
    [onWordClick]
  );
  const handleWordDoubleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      onWordDoubleClick?.({
        index: Number(event.currentTarget.dataset.wordIndex),
        text: event.currentTarget.textContent?.trim() ?? "",
      });
    },
    [onWordDoubleClick]
  );
  return (
    <div className="px-1 pb-4">
      <p className="mb-1 flex items-baseline gap-2 text-xs">
        {onSpeakerClick ? (
          <button
            className={`cursor-pointer font-medium hover:underline ${speakerColorClass(paragraph.speaker)}`}
            data-testid="transcript-speaker"
            onClick={onSpeakerClick}
            type="button"
          >
            {speakerLabel}
          </button>
        ) : (
          <span
            className={`font-medium ${speakerColorClass(paragraph.speaker)}`}
            data-testid="transcript-speaker"
          >
            {speakerLabel}
          </span>
        )}
        <span className="text-muted-foreground tabular-nums">
          {formatTimestamp(paragraph.startMs)}
        </span>
      </p>
      <p className="text-sm leading-6">
        {paragraph.words.map((word, localIndex) => {
          const globalIndex = paragraph.wordOffset + localIndex;
          const isActive = globalIndex === activeWordIndex;
          const isMatch =
            query.length > 0 && word.text.toLowerCase().includes(query);
          const isFocusedMatch = globalIndex === focusedMatchIndex;
          const lowConfidence =
            word.confidence !== null &&
            word.confidence < LOW_CONFIDENCE_THRESHOLD;
          let background = "";
          if (isActive) {
            background = "bg-primary/20 rounded-sm";
          } else if (isFocusedMatch) {
            background = "bg-amber-400/50 rounded-sm";
          } else if (isMatch) {
            background = "bg-amber-200/40 dark:bg-amber-300/20 rounded-sm";
          }
          return (
            // The separator lives OUTSIDE the button: inline-block elements
            // swallow trailing whitespace, which rendered every paragraph
            // as one unbroken string.
            <Fragment key={globalIndex}>
              <button
                className={`cursor-pointer rounded-sm hover:bg-muted ${background} ${
                  lowConfidence
                    ? "underline decoration-amber-500 decoration-dotted underline-offset-4"
                    : ""
                }`}
                data-low-confidence={lowConfidence || undefined}
                data-start-ms={word.startMs}
                data-word-index={globalIndex}
                onClick={handleWordClick}
                onDoubleClick={handleWordDoubleClick}
                type="button"
              >
                {word.text}
              </button>{" "}
            </Fragment>
          );
        })}
      </p>
    </div>
  );
});

interface TranscriptPanelProps {
  // Present when the viewer can correct: revision the page rendered
  // (optimistic-concurrency base) and the source to correct.
  editable: { baseRevision: number; sourceId: string } | null;
  speakerLabels: Record<string, string> | null;
  transcriptUrl: string;
  video: HTMLVideoElement | null;
}

export function TranscriptPanel({
  editable,
  speakerLabels,
  transcriptUrl,
  video,
}: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [data, setData] = useState<TranscriptData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [activeWordIndex, setActiveWordIndex] = useState(-1);
  const [following, setFollowing] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  const [speakersOpen, setSpeakersOpen] = useState(false);
  const [wordToCorrect, setWordToCorrect] = useState<WordToCorrect | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    fetch(transcriptUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`transcript fetch ${response.status}`);
        }
        return response.json() as Promise<TranscriptData>;
      })
      .then((json) => {
        if (!cancelled) {
          setData(json);
        }
      })
      .catch((error) => {
        console.error("[transcript] load failed:", error);
        if (!cancelled) {
          setLoadError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [transcriptUrl]);

  const paragraphs = useMemo(() => (data ? buildParagraphs(data) : []), [data]);
  const words = data?.words ?? [];

  // Active word from playback time. timeupdate is ~4 Hz — cheap; the
  // binary search keeps each tick O(log n) and setState fires only on
  // change, so paused playback re-renders nothing.
  useEffect(() => {
    if (!(video && data)) {
      return;
    }
    const handleTimeUpdate = () => {
      // React bails out when the value is unchanged (Object.is), so ticks
      // within one word re-render nothing.
      setActiveWordIndex(
        findWordIndexAtTime(data.words, video.currentTime * 1000)
      );
    };
    handleTimeUpdate();
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("seeked", handleTimeUpdate);
    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("seeked", handleTimeUpdate);
    };
  }, [video, data]);

  const virtualizer = useVirtualizer({
    count: paragraphs.length,
    estimateSize: (index) => {
      const paragraph = paragraphs[index];
      if (!paragraph) {
        return ROW_ESTIMATE_CHROME + ROW_ESTIMATE_LINE_HEIGHT;
      }
      const chars = paragraph.words.reduce(
        (total, word) => total + word.text.length + 1,
        0
      );
      const lines = Math.max(1, Math.ceil(chars / ROW_ESTIMATE_CHARS_PER_LINE));
      return ROW_ESTIMATE_CHROME + lines * ROW_ESTIMATE_LINE_HEIGHT;
    },
    getScrollElement: () => scrollRef.current,
    overscan: 6,
  });

  const activeParagraphIndex = findParagraphIndexForWord(
    paragraphs,
    activeWordIndex
  );

  // Follow-scroll: keep the active paragraph in view while playing, unless
  // the user has scrolled away. scrollToIndex is used (not scrollIntoView on
  // the DOM node) because the target row may not be mounted at all.
  useEffect(() => {
    if (following && activeParagraphIndex >= 0) {
      virtualizer.scrollToIndex(activeParagraphIndex, { align: "center" });
    }
  }, [following, activeParagraphIndex, virtualizer]);

  const matches = useMemo(() => {
    const query = searchQuery.toLowerCase();
    if (query.length === 0) {
      return [];
    }
    const found: number[] = [];
    for (const [index, word] of words.entries()) {
      if (word.text.toLowerCase().includes(query)) {
        found.push(index);
      }
    }
    return found;
  }, [words, searchQuery]);

  const focusedMatchIndex =
    matches.length > 0 ? (matches[matchCursor % matches.length] ?? -1) : -1;

  const seekTo = useCallback(
    (startMs: number) => {
      if (video) {
        video.currentTime = startMs / 1000;
      }
      setFollowing(true);
    },
    [video]
  );
  const handleSearchChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(event.target.value);
      setMatchCursor(0);
    },
    []
  );
  const matchCount = matches.length;
  const handlePrevMatch = useCallback(() => {
    setMatchCursor(
      (cursor) => (cursor - 1 + matchCount) % Math.max(1, matchCount)
    );
  }, [matchCount]);
  const handleNextMatch = useCallback(() => {
    setMatchCursor((cursor) => (cursor + 1) % Math.max(1, matchCount));
  }, [matchCount]);
  const resumeFollow = useCallback(() => setFollowing(true), []);
  const suspendFollow = useCallback(() => setFollowing(false), []);
  const openSpeakers = useCallback(() => setSpeakersOpen(true), []);
  const closeSpeakers = useCallback(() => setSpeakersOpen(false), []);
  const closeCorrect = useCallback(() => setWordToCorrect(null), []);

  const speakers = useMemo(() => {
    const ids = new Set<string>();
    for (const word of words) {
      if (word.speaker !== null) {
        ids.add(word.speaker);
      }
    }
    return [...ids].sort((a, b) => Number(a) - Number(b));
  }, [words]);

  // Jumping between matches scrolls to the match's paragraph — a search
  // jump is an explicit navigation, so it also suspends following.
  useEffect(() => {
    if (focusedMatchIndex < 0) {
      return;
    }
    const paragraphIndex = findParagraphIndexForWord(
      paragraphs,
      focusedMatchIndex
    );
    if (paragraphIndex >= 0) {
      setFollowing(false);
      virtualizer.scrollToIndex(paragraphIndex, { align: "center" });
    }
  }, [focusedMatchIndex, paragraphs, virtualizer]);

  if (loadError) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-testid="transcript-load-error"
      >
        The transcript could not be loaded. Reload to try again.
      </p>
    );
  }

  if (!data) {
    return <p className="text-muted-foreground text-sm">Loading transcript…</p>;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="transcript-panel">
      <div className="flex items-center gap-2">
        <Input
          className="max-w-xs"
          data-testid="transcript-search"
          onChange={handleSearchChange}
          placeholder="Search transcript…"
          value={searchQuery}
        />
        {searchQuery ? (
          <>
            <span
              className="text-muted-foreground text-xs tabular-nums"
              data-testid="transcript-match-count"
            >
              {matches.length === 0
                ? "0 matches"
                : `${(matchCursor % matches.length) + 1} of ${matches.length}`}
            </span>
            <Button
              disabled={matches.length === 0}
              onClick={handlePrevMatch}
              size="sm"
              type="button"
              variant="outline"
            >
              Prev
            </Button>
            <Button
              data-testid="transcript-match-next"
              disabled={matches.length === 0}
              onClick={handleNextMatch}
              size="sm"
              type="button"
              variant="outline"
            >
              Next
            </Button>
          </>
        ) : null}
        {following ? null : (
          <Button
            className="ml-auto"
            data-testid="transcript-follow"
            onClick={resumeFollow}
            size="sm"
            type="button"
            variant="outline"
          >
            Jump to current
          </Button>
        )}
        {editable ? (
          <div className={following ? "ml-auto flex gap-2" : "flex gap-2"}>
            <Button
              data-testid="transcript-speakers"
              onClick={openSpeakers}
              size="sm"
              type="button"
              variant="outline"
            >
              Speakers
            </Button>
            <Button
              data-testid="transcript-export-srt"
              nativeButton={false}
              render={
                <a
                  href={`/api/sources/${editable.sourceId}/transcript?format=srt`}
                />
              }
              size="sm"
              variant="outline"
            >
              SRT
            </Button>
            <Button
              data-testid="transcript-export-vtt"
              nativeButton={false}
              render={
                <a
                  href={`/api/sources/${editable.sourceId}/transcript?format=vtt`}
                />
              }
              size="sm"
              variant="outline"
            >
              VTT
            </Button>
          </div>
        ) : null}
      </div>
      <div
        className="h-[480px] overflow-y-auto rounded-md border"
        onTouchMove={suspendFollow}
        onWheel={suspendFollow}
        ref={scrollRef}
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const paragraph = paragraphs[item.index];
            if (!paragraph) {
              return null;
            }
            const lastWordIndex =
              paragraph.wordOffset + paragraph.words.length - 1;
            const contains = (globalIndex: number) =>
              globalIndex >= paragraph.wordOffset &&
              globalIndex <= lastWordIndex;
            return (
              <div
                className="absolute top-0 left-0 w-full px-3 pt-3"
                data-index={item.index}
                key={item.key}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <ParagraphRow
                  activeWordIndex={
                    contains(activeWordIndex) ? activeWordIndex : -1
                  }
                  focusedMatchIndex={
                    contains(focusedMatchIndex) ? focusedMatchIndex : -1
                  }
                  onSpeakerClick={editable ? openSpeakers : null}
                  onWordClick={seekTo}
                  onWordDoubleClick={editable ? setWordToCorrect : null}
                  paragraph={paragraph}
                  searchQuery={searchQuery}
                  speakerLabel={speakerDisplayName(
                    paragraph.speaker,
                    speakerLabels
                  )}
                />
              </div>
            );
          })}
        </div>
      </div>
      {editable ? (
        <>
          <SpeakerLabelsDialog
            onClose={closeSpeakers}
            open={speakersOpen}
            sourceId={editable.sourceId}
            speakerLabels={speakerLabels}
            speakers={speakers}
          />
          <CorrectWordDialog
            baseRevision={editable.baseRevision}
            onClose={closeCorrect}
            sourceId={editable.sourceId}
            word={wordToCorrect}
          />
        </>
      ) : null}
    </div>
  );
}
