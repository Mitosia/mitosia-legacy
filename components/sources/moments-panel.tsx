"use client";

import { useRouter } from "next/navigation";
import {
  startTransition,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  decideMomentAction,
  rerunDiscoveryAction,
  saveBoundariesAction,
} from "@/lib/actions/moments";
import {
  sentenceEndTimes,
  sentenceStartTimes,
} from "@/lib/intelligence/moments";
import type { TranscriptData } from "@/lib/transcription/types";

// Moments review (S6): the discovery candidates rendered for the Gate M1
// workflow — play each with context, adjust boundaries on the sentence
// grid, accept/shortlist/reject with reasons. Every decision routes
// through lib/actions/moments.ts (columns + audit, D5); nothing here is
// client-only state. The default frame is the top ten by rank because
// that is exactly what the M1 review reads.
//
// Boundary nudges are pure sentence-grid math over the transcript words
// (lib/intelligence/moments.ts helpers are client-safe); the words load
// from the same /api/media URL the transcript panel uses, which the proxy
// serves with private caching — no second real download.

export type MomentStatus = "accepted" | "proposed" | "rejected" | "shortlisted";

export interface MomentCandidateView {
  adjustedEndMs: number | null;
  adjustedStartMs: number | null;
  composite: number;
  endMs: number;
  hook: string;
  id: string;
  rank: number;
  rejectReason: string | null;
  // Cold-context reviewer verdict (null = not reviewed). Flagged rows
  // surface the agent's one suggested fix to the human reviewer.
  reviewFix: string | null;
  reviewFlagged: boolean;
  reviewNotes: string | null;
  scores: {
    comprehensibility: number;
    hook: number;
    insight: number;
    relevance: number;
    risk: number;
  };
  seedCount: number;
  sensitive: boolean;
  startMs: number;
  status: MomentStatus;
  summary: string;
  title: string;
}

export interface MomentsRun {
  error: string | null;
  // Current transcript revision is newer than the one discovered from
  stale: boolean;
  status: string;
}

// 3s of lead-in so the reviewer hears the moment arrive in context.
const PLAY_PREROLL_MS = 3000;
const DEFAULT_VISIBLE = 10;

const REJECT_REASON_LABELS: Record<string, string> = {
  duplicate: "Duplicate",
  not_interesting: "Not interesting",
  other: "Other",
  out_of_context: "Out of context",
  sensitive: "Too sensitive",
  wrong_boundaries: "Wrong boundaries",
};
const REJECT_REASON_ORDER = [
  "not_interesting",
  "wrong_boundaries",
  "out_of_context",
  "sensitive",
  "duplicate",
  "other",
];

const REVIEW_FIX_LABELS: Record<string, string> = {
  drop: "Reviewer: consider dropping",
  extend_start: "Reviewer: extend start",
  none: "Reviewer: check",
  retitle: "Reviewer: retitle",
  trim_end: "Reviewer: trim end",
};

const STATUS_LABELS: Record<MomentStatus, string> = {
  accepted: "Accepted",
  proposed: "Proposed",
  rejected: "Rejected",
  shortlisted: "Shortlisted",
};

function stamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function formatDeltaSeconds(deltaMs: number): string {
  const seconds = deltaMs / 1000;
  return `${seconds > 0 ? "+" : ""}${seconds.toFixed(1)}s`;
}

export function RerunDiscoveryButton({
  label = "Run discovery again",
  sourceId,
  testId = "rerun-discovery",
}: {
  label?: string;
  sourceId: string;
  testId?: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(rerunDiscoveryAction, {});
  useEffect(() => {
    if (state.success) {
      router.refresh();
    }
  }, [state.success, router]);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input name="sourceId" type="hidden" value={sourceId} />
      <Button
        data-testid={testId}
        disabled={pending}
        size="sm"
        type="submit"
        variant="outline"
      >
        {pending ? "Starting…" : label}
      </Button>
      {state.error ? (
        <p
          className="text-destructive text-sm"
          data-testid="rerun-discovery-error"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

interface NudgeControlsProps {
  candidate: MomentCandidateView;
  onPlayFrom: (ms: number) => void;
  words: TranscriptData["words"] | null;
}

// In/out nudges walk the sentence grid: ‹/› move the in-point to the
// previous/next sentence START and the out-point to the previous/next
// sentence END. Each press persists immediately (a human clicks these one
// at a time); the running delta vs. the snapped bounds is the boundary-
// adjustment instrumentation, shown live.
function NudgeControls({ candidate, onPlayFrom, words }: NudgeControlsProps) {
  // Optimistic bounds: nudges update locally and persist in the same
  // click; the server row reconciles through revalidation.
  const [bounds, setBounds] = useState({
    inMs: candidate.adjustedStartMs ?? candidate.startMs,
    outMs: candidate.adjustedEndMs ?? candidate.endMs,
  });
  useEffect(() => {
    setBounds({
      inMs: candidate.adjustedStartMs ?? candidate.startMs,
      outMs: candidate.adjustedEndMs ?? candidate.endMs,
    });
  }, [
    candidate.adjustedStartMs,
    candidate.adjustedEndMs,
    candidate.startMs,
    candidate.endMs,
  ]);
  const { inMs, outMs } = bounds;
  const [state, formAction, pending] = useActionState(saveBoundariesAction, {});

  const grid = useMemo(() => {
    if (!words || words.length === 0) {
      return null;
    }
    return {
      ends: sentenceEndTimes(words),
      starts: sentenceStartTimes(words),
    };
  }, [words]);

  const targets = useMemo(() => {
    if (!grid) {
      return null;
    }
    const before = (times: number[], at: number) =>
      times.filter((time) => time < at).at(-1);
    const after = (times: number[], at: number) =>
      times.find((time) => time > at);
    const valid = (nextIn: number | undefined, nextOut: number | undefined) =>
      nextIn !== undefined && nextOut !== undefined && nextIn < nextOut
        ? { in: nextIn, out: nextOut }
        : undefined;
    return {
      inNext: valid(after(grid.starts, inMs), outMs),
      inPrev: valid(before(grid.starts, inMs), outMs),
      outNext: valid(inMs, after(grid.ends, outMs)),
      outPrev: valid(inMs, before(grid.ends, outMs)),
    };
  }, [grid, inMs, outMs]);

  const nudge = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const key = event.currentTarget.dataset.nudge as
        | keyof NonNullable<typeof targets>
        | undefined;
      const target = key ? targets?.[key] : undefined;
      if (!target) {
        return;
      }
      setBounds({ inMs: target.in, outMs: target.out });
      const formData = new FormData();
      formData.set("candidateId", candidate.id);
      formData.set("adjustedStartMs", String(target.in));
      formData.set("adjustedEndMs", String(target.out));
      startTransition(() => {
        formAction(formData);
      });
    },
    [targets, candidate.id, formAction]
  );

  const playFromIn = useCallback(() => {
    onPlayFrom(inMs);
  }, [onPlayFrom, inMs]);

  const deltaIn = inMs - candidate.startMs;
  const deltaOut = outMs - candidate.endMs;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">In</span>
      <Button
        aria-label="Move in-point to previous sentence"
        data-nudge="inPrev"
        data-testid="moment-nudge-in-prev"
        disabled={pending || !targets?.inPrev}
        onClick={nudge}
        size="icon-sm"
        type="button"
        variant="outline"
      >
        ‹
      </Button>
      <Button
        aria-label="Move in-point to next sentence"
        data-nudge="inNext"
        data-testid="moment-nudge-in-next"
        disabled={pending || !targets?.inNext}
        onClick={nudge}
        size="icon-sm"
        type="button"
        variant="outline"
      >
        ›
      </Button>
      <span className="text-muted-foreground">Out</span>
      <Button
        aria-label="Move out-point to previous sentence"
        data-nudge="outPrev"
        data-testid="moment-nudge-out-prev"
        disabled={pending || !targets?.outPrev}
        onClick={nudge}
        size="icon-sm"
        type="button"
        variant="outline"
      >
        ‹
      </Button>
      <Button
        aria-label="Move out-point to next sentence"
        data-nudge="outNext"
        data-testid="moment-nudge-out-next"
        disabled={pending || !targets?.outNext}
        onClick={nudge}
        size="icon-sm"
        type="button"
        variant="outline"
      >
        ›
      </Button>
      {deltaIn !== 0 || deltaOut !== 0 ? (
        <span className="tabular-nums" data-testid="moment-nudge-delta">
          {deltaIn === 0 ? null : `in ${formatDeltaSeconds(deltaIn)}`}
          {deltaIn !== 0 && deltaOut !== 0 ? " · " : null}
          {deltaOut === 0 ? null : `out ${formatDeltaSeconds(deltaOut)}`}
        </span>
      ) : null}
      <Button
        data-testid="moment-play-in"
        onClick={playFromIn}
        size="sm"
        type="button"
        variant="ghost"
      >
        Play from in-point
      </Button>
      {state.error ? (
        <span className="text-destructive">{state.error}</span>
      ) : null}
    </div>
  );
}

function DecisionControls({ candidate }: { candidate: MomentCandidateView }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(decideMomentAction, {});
  useEffect(() => {
    if (state.success) {
      router.refresh();
    }
  }, [state.success, router]);

  const decide = useCallback(
    (decision: string, rejectReason?: string) => {
      const formData = new FormData();
      formData.set("candidateId", candidate.id);
      formData.set("decision", decision);
      if (rejectReason) {
        formData.set("rejectReason", rejectReason);
      }
      startTransition(() => {
        formAction(formData);
      });
    },
    [candidate.id, formAction]
  );
  const onDecide = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const { decision } = event.currentTarget.dataset;
      if (decision) {
        decide(decision);
      }
    },
    [decide]
  );
  const onReject = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const { reason } = event.currentTarget.dataset;
      if (reason) {
        decide("rejected", reason);
      }
    },
    [decide]
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        data-decision="accepted"
        data-testid="moment-accept"
        disabled={pending || candidate.status === "accepted"}
        onClick={onDecide}
        size="sm"
        type="button"
        variant="default"
      >
        Accept
      </Button>
      <Button
        data-decision="shortlisted"
        data-testid="moment-shortlist"
        disabled={pending || candidate.status === "shortlisted"}
        onClick={onDecide}
        size="sm"
        type="button"
        variant="secondary"
      >
        Shortlist
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              data-testid="moment-reject"
              disabled={pending || candidate.status === "rejected"}
              size="sm"
              type="button"
              variant="outline"
            />
          }
        >
          Reject…
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuGroup>
            {REJECT_REASON_ORDER.map((reason) => (
              <DropdownMenuItem
                data-reason={reason}
                data-testid="moment-reject-reason"
                key={reason}
                onClick={onReject}
              >
                {REJECT_REASON_LABELS[reason]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {candidate.status === "proposed" ? null : (
        <Badge
          data-testid="moment-status"
          variant={candidate.status === "rejected" ? "outline" : "secondary"}
        >
          {STATUS_LABELS[candidate.status]}
          {candidate.rejectReason
            ? ` · ${REJECT_REASON_LABELS[candidate.rejectReason] ?? candidate.rejectReason}`
            : null}
        </Badge>
      )}
      {state.error ? (
        <p className="text-destructive text-xs">{state.error}</p>
      ) : null}
    </div>
  );
}

interface MomentCardProps {
  candidate: MomentCandidateView;
  onPlay: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onPlayFrom: (ms: number) => void;
  words: TranscriptData["words"] | null;
}

function MomentCard({ candidate, onPlay, onPlayFrom, words }: MomentCardProps) {
  const inMs = candidate.adjustedStartMs ?? candidate.startMs;
  const outMs = candidate.adjustedEndMs ?? candidate.endMs;
  const durationSeconds = Math.round((outMs - inMs) / 1000);
  const { scores } = candidate;

  return (
    <li
      className="flex flex-col gap-2 rounded-md border p-3"
      data-candidate-id={candidate.id}
      data-testid="moment-item"
    >
      <button
        className="flex w-full cursor-pointer flex-col items-start gap-1 text-left"
        data-start-ms={inMs}
        data-testid="moment-card"
        onClick={onPlay}
        type="button"
      >
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs tabular-nums">
            #{candidate.rank + 1}
          </span>
          <span className="font-medium text-sm">{candidate.title}</span>
          {candidate.sensitive ? (
            <Badge data-testid="moment-sensitive" variant="outline">
              Sensitive
            </Badge>
          ) : null}
          {candidate.reviewFlagged ? (
            <Badge data-testid="moment-review-flag" variant="outline">
              {REVIEW_FIX_LABELS[candidate.reviewFix ?? "none"] ??
                "Reviewer: check"}
            </Badge>
          ) : null}
        </span>
        <span className="text-muted-foreground text-sm">{candidate.hook}</span>
        <span className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs tabular-nums">
          <span>
            {stamp(inMs)}–{stamp(outMs)}
          </span>
          <Badge variant="secondary">{durationSeconds}s</Badge>
          <span data-testid="moment-composite">
            score {candidate.composite.toFixed(2)}
          </span>
          <span>
            hook {scores.hook.toFixed(1)} · insight {scores.insight.toFixed(1)}{" "}
            · clarity {scores.comprehensibility.toFixed(1)} · relevance{" "}
            {scores.relevance.toFixed(1)}
          </span>
          {candidate.seedCount > 0 ? (
            <span data-testid="moment-seeds">
              from {candidate.seedCount} highlight
              {candidate.seedCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </span>
        <span className="line-clamp-2 text-muted-foreground text-xs">
          {candidate.summary}
        </span>
        {candidate.reviewFlagged && candidate.reviewNotes ? (
          <span
            className="line-clamp-2 text-muted-foreground text-xs italic"
            data-testid="moment-review-notes"
          >
            {candidate.reviewNotes}
          </span>
        ) : null}
      </button>
      <NudgeControls
        candidate={candidate}
        onPlayFrom={onPlayFrom}
        words={words}
      />
      <DecisionControls candidate={candidate} />
    </li>
  );
}

function decisionReadout(
  candidates: readonly MomentCandidateView[]
): string | null {
  const accepted = candidates.filter((c) => c.status === "accepted").length;
  const shortlisted = candidates.filter(
    (c) => c.status === "shortlisted"
  ).length;
  const rejected = candidates.filter((c) => c.status === "rejected").length;
  if (accepted + shortlisted + rejected === 0) {
    return null;
  }
  const parts = [
    accepted > 0 ? `${accepted} accepted` : null,
    shortlisted > 0 ? `${shortlisted} shortlisted` : null,
    rejected > 0 ? `${rejected} rejected` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function MomentsStateCard({
  children,
  description,
}: {
  children?: React.ReactNode;
  description: string;
}) {
  return (
    <Card data-testid="moments-panel">
      <CardHeader>
        <CardTitle>Moments</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children ? (
        <CardContent className="flex flex-col gap-2">{children}</CardContent>
      ) : null}
    </Card>
  );
}

export function MomentsPanel({
  candidates,
  run,
  sourceId,
  transcriptUrl,
  video,
}: {
  candidates: MomentCandidateView[];
  run: MomentsRun;
  sourceId: string;
  transcriptUrl: string | null;
  video: HTMLVideoElement | null;
}) {
  if (run.status === "missing") {
    return (
      <MomentsStateCard description="Find the standalone clip-worthy moments in this recording — scored, deduped, and grounded to their exact spans.">
        <RerunDiscoveryButton
          label="Find moments"
          sourceId={sourceId}
          testId="find-moments"
        />
      </MomentsStateCard>
    );
  }
  if (run.status === "pending" || run.status === "processing") {
    return (
      <MomentsStateCard description="Finding clip-worthy moments… This page updates automatically." />
    );
  }
  if (run.status === "failed") {
    return (
      <MomentsStateCard description="Moment discovery failed. You can run it again.">
        {run.error ? (
          <p className="break-words text-muted-foreground text-xs">
            {run.error}
          </p>
        ) : null}
        <RerunDiscoveryButton sourceId={sourceId} />
      </MomentsStateCard>
    );
  }
  return (
    <MomentsReady
      candidates={candidates}
      sourceId={sourceId}
      stale={run.stale}
      transcriptUrl={transcriptUrl}
      video={video}
    />
  );
}

function MomentsReady({
  candidates,
  sourceId,
  stale,
  transcriptUrl,
  video,
}: {
  candidates: MomentCandidateView[];
  sourceId: string;
  stale: boolean;
  transcriptUrl: string | null;
  video: HTMLVideoElement | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<"rejected" | "top">("top");
  const [words, setWords] = useState<TranscriptData["words"] | null>(null);

  // Same object the transcript panel fetches; the media proxy marks it
  // private-cacheable, so this is a browser-cache read, not a re-download.
  useEffect(() => {
    if (!transcriptUrl) {
      return;
    }
    let cancelled = false;
    fetch(transcriptUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`transcript fetch ${response.status}`);
        }
        return response.json() as Promise<TranscriptData>;
      })
      .then((data) => {
        if (!cancelled) {
          setWords(data.words);
        }
      })
      .catch(() => {
        // Nudges stay disabled without the word timeline; playback and
        // decisions are unaffected.
      });
    return () => {
      cancelled = true;
    };
  }, [transcriptUrl]);

  const onPlay = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const startMs = Number(event.currentTarget.dataset.startMs);
      if (video && Number.isFinite(startMs)) {
        video.currentTime = Math.max(0, startMs - PLAY_PREROLL_MS) / 1000;
        video.play().catch(() => {
          // Autoplay policies can refuse; the seek alone still lands
        });
      }
    },
    [video]
  );
  const onPlayFrom = useCallback(
    (ms: number) => {
      if (video) {
        video.currentTime = ms / 1000;
        video.play().catch(() => {
          // Autoplay policies can refuse; the seek alone still lands
        });
      }
    },
    [video]
  );
  const onViewChange = useCallback((groupValue: unknown[]) => {
    const next = groupValue.at(0);
    if (next === "top" || next === "rejected") {
      setView(next);
    }
  }, []);
  const toggleShowAll = useCallback(() => {
    setShowAll((current) => !current);
  }, []);

  const active = useMemo(
    () =>
      view === "rejected"
        ? candidates.filter((candidate) => candidate.status === "rejected")
        : candidates.filter((candidate) => candidate.status !== "rejected"),
    [candidates, view]
  );
  const visible =
    view === "top" && !showAll ? active.slice(0, DEFAULT_VISIBLE) : active;
  const rejectedCount =
    candidates.length - (view === "rejected" ? 0 : active.length);
  const readout = decisionReadout(candidates);

  return (
    <Card data-testid="moments-panel">
      <CardHeader>
        <CardTitle>Moments ({candidates.length})</CardTitle>
        <CardDescription>
          {candidates.length > 0
            ? "Clip-worthy candidates, ranked — click one to play it with context."
            : "No standalone clip-worthy moments were found in this recording."}
          {readout ? (
            <span className="ml-2" data-testid="moments-readout">
              {readout}
            </span>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {stale ? (
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
            <span>The transcript changed since these were discovered.</span>
            <RerunDiscoveryButton sourceId={sourceId} />
          </div>
        ) : null}
        {rejectedCount > 0 || view === "rejected" ? (
          <ToggleGroup
            onValueChange={onViewChange}
            size="sm"
            value={[view]}
            variant="outline"
          >
            <ToggleGroupItem data-testid="moments-view-top" value="top">
              Top
            </ToggleGroupItem>
            <ToggleGroupItem
              data-testid="moments-view-rejected"
              value="rejected"
            >
              Rejected
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
        {visible.length > 0 ? (
          <ol className="flex flex-col gap-3">
            {visible.map((candidate) => (
              <MomentCard
                candidate={candidate}
                key={candidate.id}
                onPlay={onPlay}
                onPlayFrom={onPlayFrom}
                words={words}
              />
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground text-sm">
            {view === "rejected" ? "Nothing rejected yet." : null}
          </p>
        )}
        {view === "top" && active.length > DEFAULT_VISIBLE ? (
          <Button
            data-testid="moments-show-all"
            onClick={toggleShowAll}
            size="sm"
            type="button"
            variant="ghost"
          >
            {showAll ? "Show top 10" : `Show all ${active.length}`}
          </Button>
        ) : null}
        <RerunDiscoveryButton sourceId={sourceId} />
      </CardContent>
    </Card>
  );
}
