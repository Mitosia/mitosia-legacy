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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  decideSegmentAction,
  mergeSegmentAction,
  planSegmentsAction,
  restoreSegmentAction,
  saveSegmentBoundariesAction,
  saveSegmentMetadataAction,
} from "@/lib/actions/segments";
import { sentenceStartTimes } from "@/lib/intelligence/moments";
import type { TranscriptData } from "@/lib/transcription/types";
import type { RangePlayback } from "./use-range-playback";

// Segment plan review (S6.5): the episode's keep/drop partition rendered
// chronologically — every second accounted for. Keep cards play with
// context, nudge on the sentence grid, and take accept/reject decisions;
// drop rows show their reason and are restorable. Same D5 contract as the
// moments panel: decisions are columns + audit rows, never client state.

export type SegmentStatusValue = "accepted" | "proposed" | "rejected";

export interface SegmentView {
  adjustedEndMs: number | null;
  adjustedStartMs: number | null;
  dropReason: string | null;
  endMs: number;
  flags: string[];
  hook: string | null;
  id: string;
  idx: number;
  kind: "drop" | "keep";
  rejectReason: string | null;
  reviewFix: string | null;
  reviewFlagged: boolean;
  reviewNotes: string | null;
  startMs: number;
  status: SegmentStatusValue;
  summary: string | null;
  title: string | null;
}

export interface SegmentsRun {
  error: string | null;
  stale: boolean;
  status: string;
}

const PLAY_PREROLL_MS = 3000;

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

const DROP_REASON_LABELS: Record<string, string> = {
  housekeeping: "Housekeeping",
  low_energy: "Low energy",
  other: "Not clip-worthy",
  sponsor: "Sponsor read",
  thin: "Thin content",
  weaker_telling: "Weaker telling",
};

const FLAG_LABELS: Record<string, string> = {
  gap_fill: "Uncovered stretch",
  human_merged: "Merged by editor",
  human_restored: "Restored by editor",
  long_outlier: "Unusually long",
  merged_neighbor: "Merged proposals",
  needs_metadata_review: "Review title and summary",
  no_anchor: "No anchor",
  same_topic_neighbors: "Same topic as neighbor",
  short_outlier: "Unusually short",
  twice_told: "Told twice",
  ungrounded_after_edit: "Anchor falls outside edited range",
};

const REVIEW_FIX_LABELS: Record<string, string> = {
  drop: "Reviewer: consider dropping",
  extend_end: "Reviewer: extend end",
  extend_start: "Reviewer: extend start",
  none: "Reviewer: check",
  retitle: "Reviewer: retitle",
  trim_end: "Reviewer: trim end",
  trim_start: "Reviewer: trim start",
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

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  return minutes >= 10
    ? `${Math.round(minutes)} min`
    : `${minutes.toFixed(1)} min`;
}

function effectiveStart(segment: SegmentView): number {
  return segment.adjustedStartMs ?? segment.startMs;
}

function effectiveEnd(segment: SegmentView): number {
  return segment.adjustedEndMs ?? segment.endMs;
}

export function PlanSegmentsButton({
  label = "Plan segment clips again",
  sourceId,
  testId = "rerun-segments",
}: {
  label?: string;
  sourceId: string;
  testId?: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(planSegmentsAction, {});
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
        <div className="flex flex-wrap items-center gap-2">
          <p
            className="text-destructive text-sm"
            data-testid="rerun-segments-error"
          >
            {state.error}
          </p>
          {state.error.includes("human review or edits") ? (
            <>
              <input
                name="expectedRunId"
                type="hidden"
                value={state.protectedRunId}
              />
              <input
                name="expectedEditVersion"
                type="hidden"
                value={state.protectedEditVersion}
              />
              <Button
                disabled={pending}
                name="force"
                size="sm"
                type="submit"
                value="true"
                variant="destructive"
              >
                Re-plan and discard edits
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function SegmentNudges({
  nextSegment,
  onPlayFrom,
  previousSegment,
  segment,
  words,
}: {
  nextSegment: SegmentView | null;
  onPlayFrom: (startMs: number, endMs: number) => void;
  previousSegment: SegmentView | null;
  segment: SegmentView;
  words: TranscriptData["words"] | null;
}) {
  const router = useRouter();
  const [bounds, setBounds] = useState({
    inMs: segment.adjustedStartMs ?? segment.startMs,
    outMs: segment.adjustedEndMs ?? segment.endMs,
  });
  useEffect(() => {
    setBounds({
      inMs: segment.adjustedStartMs ?? segment.startMs,
      outMs: segment.adjustedEndMs ?? segment.endMs,
    });
  }, [
    segment.adjustedStartMs,
    segment.adjustedEndMs,
    segment.startMs,
    segment.endMs,
  ]);
  const { inMs, outMs } = bounds;
  const [state, formAction, pending] = useActionState(
    saveSegmentBoundariesAction,
    {}
  );
  useEffect(() => {
    if (state.success) {
      router.refresh();
    }
  }, [state.success, router]);

  const grid = useMemo(() => {
    if (!words || words.length === 0) {
      return null;
    }
    return {
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
    const valid = (
      boundary: number | undefined,
      outerStart: number,
      outerEnd: number
    ) =>
      boundary !== undefined && boundary > outerStart && boundary < outerEnd
        ? boundary
        : undefined;
    return {
      inNext: previousSegment
        ? valid(
            after(grid.starts, inMs),
            effectiveStart(previousSegment),
            outMs
          )
        : undefined,
      inPrev: previousSegment
        ? valid(
            before(grid.starts, inMs),
            effectiveStart(previousSegment),
            outMs
          )
        : undefined,
      outNext: nextSegment
        ? valid(after(grid.starts, outMs), inMs, effectiveEnd(nextSegment))
        : undefined,
      outPrev: nextSegment
        ? valid(before(grid.starts, outMs), inMs, effectiveEnd(nextSegment))
        : undefined,
    };
  }, [grid, inMs, nextSegment, outMs, previousSegment]);

  const nudge = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const key = event.currentTarget.dataset.nudge as
        | keyof NonNullable<typeof targets>
        | undefined;
      const boundaryMs = key ? targets?.[key] : undefined;
      const editsStart = key?.startsWith("in") ?? false;
      const leftSegment = editsStart ? previousSegment : segment;
      const rightSegment = editsStart ? segment : nextSegment;
      if (
        boundaryMs === undefined ||
        leftSegment === null ||
        rightSegment === null
      ) {
        return;
      }
      const formData = new FormData();
      formData.set("boundaryMs", String(boundaryMs));
      formData.set("leftSegmentId", leftSegment.id);
      formData.set("rightSegmentId", rightSegment.id);
      startTransition(() => {
        formAction(formData);
      });
    },
    [targets, previousSegment, segment, nextSegment, inMs, outMs, formAction]
  );
  const playFromIn = useCallback(() => {
    onPlayFrom(inMs, outMs);
  }, [onPlayFrom, inMs, outMs]);

  const deltaIn = inMs - segment.startMs;
  const deltaOut = outMs - segment.endMs;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">In</span>
      <Button
        aria-label="Move in-point to previous sentence"
        data-nudge="inPrev"
        data-testid="segment-nudge-in-prev"
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
        data-testid="segment-nudge-in-next"
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
        data-testid="segment-nudge-out-prev"
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
        data-testid="segment-nudge-out-next"
        disabled={pending || !targets?.outNext}
        onClick={nudge}
        size="icon-sm"
        type="button"
        variant="outline"
      >
        ›
      </Button>
      {deltaIn !== 0 || deltaOut !== 0 ? (
        <span className="tabular-nums" data-testid="segment-nudge-delta">
          {deltaIn === 0 ? null : `in ${formatDeltaSeconds(deltaIn)}`}
          {deltaIn !== 0 && deltaOut !== 0 ? " · " : null}
          {deltaOut === 0 ? null : `out ${formatDeltaSeconds(deltaOut)}`}
        </span>
      ) : null}
      <Button
        data-testid="segment-play-in"
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

function SegmentMergeActions({
  nextSegment,
  previousSegment,
  segment,
}: {
  nextSegment: SegmentView | null;
  previousSegment: SegmentView | null;
  segment: SegmentView;
}) {
  const router = useRouter();
  const [direction, setDirection] = useState<"next" | "previous" | null>(null);
  const [state, formAction, pending] = useActionState(mergeSegmentAction, {});
  useEffect(() => {
    if (state.success) {
      router.refresh();
    }
  }, [state.success, router]);
  const requestMerge = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const requested = event.currentTarget.dataset.direction;
      if (requested !== "previous" && requested !== "next") {
        return;
      }
      const neighbor = requested === "previous" ? previousSegment : nextSegment;
      if (neighbor?.kind !== "keep") {
        return;
      }
      setDirection(requested);
    },
    [nextSegment, previousSegment]
  );
  const confirmMerge = useCallback(() => {
    const neighbor = direction === "previous" ? previousSegment : nextSegment;
    if (!direction || neighbor?.kind !== "keep") {
      return;
    }
    const formData = new FormData();
    if (direction === "previous") {
      formData.set("destinationId", neighbor.id);
      formData.set("absorbedId", segment.id);
    } else {
      formData.set("destinationId", segment.id);
      formData.set("absorbedId", neighbor.id);
    }
    setDirection(null);
    startTransition(() => formAction(formData));
  }, [direction, formAction, nextSegment, previousSegment, segment.id]);
  const onDialogChange = useCallback((open: boolean) => {
    if (!open) {
      setDirection(null);
    }
  }, []);
  const selectedNeighbor =
    direction === "previous" ? previousSegment : nextSegment;
  const previousKeep = previousSegment?.kind === "keep";
  const nextKeep = nextSegment?.kind === "keep";
  if (!(previousKeep || nextKeep)) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {previousKeep ? (
        <Button
          data-direction="previous"
          data-testid="segment-merge-previous"
          disabled={pending}
          onClick={requestMerge}
          size="sm"
          type="button"
          variant="outline"
        >
          Merge with previous
        </Button>
      ) : null}
      {nextKeep ? (
        <Button
          data-direction="next"
          data-testid="segment-merge-next"
          disabled={pending}
          onClick={requestMerge}
          size="sm"
          type="button"
          variant="outline"
        >
          Merge with next
        </Button>
      ) : null}
      {state.error ? (
        <span className="text-destructive">{state.error}</span>
      ) : null}
      <Dialog onOpenChange={onDialogChange} open={direction !== null}>
        <DialogContent data-testid="segment-merge-dialog">
          <DialogHeader>
            <DialogTitle>Merge these chapters?</DialogTitle>
            <DialogDescription>
              “{segment.title ?? "Untitled chapter"}” and “
              {selectedNeighbor?.title ?? "Untitled chapter"}” will become one
              chapter. You will review its title, hook, and summary next.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              data-testid="segment-merge-confirm"
              disabled={pending}
              onClick={confirmMerge}
              type="button"
              variant="destructive"
            >
              Merge chapters
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SegmentMetadataEditor({ segment }: { segment: SegmentView }) {
  const router = useRouter();
  const needsReview = segment.flags.includes("needs_metadata_review");
  const [open, setOpen] = useState(needsReview);
  const [state, formAction, pending] = useActionState(
    saveSegmentMetadataAction,
    {}
  );
  useEffect(() => {
    if (needsReview) {
      setOpen(true);
    }
  }, [needsReview]);
  useEffect(() => {
    if (state.success) {
      router.refresh();
    }
  }, [state.success, router]);
  const onToggle = useCallback(
    (event: React.SyntheticEvent<HTMLDetailsElement>) => {
      setOpen(event.currentTarget.open);
    },
    []
  );

  return (
    <details
      className="rounded-md border border-dashed p-2 text-xs"
      data-testid="segment-metadata-editor"
      onToggle={onToggle}
      open={open}
    >
      <summary className="cursor-pointer font-medium">
        {needsReview
          ? "Finish title, hook, and summary"
          : "Edit chapter details"}
      </summary>
      <form
        action={formAction}
        className="mt-3 grid gap-3"
        key={`${segment.id}:${segment.title ?? ""}:${segment.hook ?? ""}:${segment.summary ?? ""}`}
      >
        <input name="segmentId" type="hidden" value={segment.id} />
        <div className="grid gap-1">
          <Label htmlFor={`segment-title-${segment.id}`}>Title</Label>
          <Input
            defaultValue={segment.title ?? ""}
            id={`segment-title-${segment.id}`}
            maxLength={120}
            name="title"
            required
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`segment-hook-${segment.id}`}>Hook</Label>
          <Input
            defaultValue={segment.hook ?? ""}
            id={`segment-hook-${segment.id}`}
            maxLength={200}
            name="hook"
            required
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`segment-summary-${segment.id}`}>Summary</Label>
          <textarea
            className="min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            defaultValue={segment.summary ?? ""}
            id={`segment-summary-${segment.id}`}
            maxLength={300}
            name="summary"
            required
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={pending} size="sm" type="submit">
            {pending ? "Saving…" : "Save chapter details"}
          </Button>
          {state.error ? (
            <span className="text-destructive">{state.error}</span>
          ) : null}
        </div>
      </form>
    </details>
  );
}

function SegmentDecisions({ segment }: { segment: SegmentView }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(decideSegmentAction, {});
  useEffect(() => {
    if (state.success) {
      router.refresh();
    }
  }, [state.success, router]);

  const decide = useCallback(
    (decision: string, rejectReason?: string) => {
      const formData = new FormData();
      formData.set("segmentId", segment.id);
      formData.set("decision", decision);
      if (rejectReason) {
        formData.set("rejectReason", rejectReason);
      }
      startTransition(() => {
        formAction(formData);
      });
    },
    [segment.id, formAction]
  );
  const onAccept = useCallback(() => {
    decide("accepted");
  }, [decide]);
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
        data-testid="segment-accept"
        disabled={
          pending ||
          segment.status === "accepted" ||
          segment.flags.includes("needs_metadata_review")
        }
        onClick={onAccept}
        size="sm"
        type="button"
        variant="default"
      >
        Accept
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              data-testid="segment-reject"
              disabled={pending || segment.status === "rejected"}
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
                data-testid="segment-reject-reason"
                key={reason}
                onClick={onReject}
              >
                {REJECT_REASON_LABELS[reason]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {segment.status === "proposed" ? null : (
        <Badge
          data-testid="segment-status"
          variant={segment.status === "rejected" ? "outline" : "secondary"}
        >
          {segment.status === "accepted" ? "Accepted" : "Rejected"}
          {segment.rejectReason
            ? ` · ${REJECT_REASON_LABELS[segment.rejectReason] ?? segment.rejectReason}`
            : null}
        </Badge>
      )}
      {state.error ? (
        <p className="text-destructive text-xs">{state.error}</p>
      ) : null}
    </div>
  );
}

function DropRow({ segment }: { segment: SegmentView }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(restoreSegmentAction, {});
  useEffect(() => {
    if (state.success) {
      router.refresh();
    }
  }, [state.success, router]);
  const restore = useCallback(() => {
    const formData = new FormData();
    formData.set("segmentId", segment.id);
    startTransition(() => {
      formAction(formData);
    });
  }, [segment.id, formAction]);

  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-1.5 text-muted-foreground text-xs"
      data-testid="segment-drop"
    >
      <span className="tabular-nums">
        {stamp(effectiveStart(segment))}–{stamp(effectiveEnd(segment))}
      </span>
      <span>Dropped · {DROP_REASON_LABELS[segment.dropReason ?? "other"]}</span>
      {segment.flags.includes("gap_fill") ? (
        <Badge variant="outline">{FLAG_LABELS.gap_fill}</Badge>
      ) : null}
      <Button
        data-testid="segment-restore"
        disabled={pending}
        onClick={restore}
        size="sm"
        type="button"
        variant="ghost"
      >
        Restore
      </Button>
      {state.error ? (
        <span className="text-destructive">{state.error}</span>
      ) : null}
    </li>
  );
}

function KeepCard({
  nextSegment,
  onPlay,
  onPlayFrom,
  position,
  previousSegment,
  segment,
  words,
}: {
  nextSegment: SegmentView | null;
  onPlay: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onPlayFrom: (startMs: number, endMs: number) => void;
  position: number;
  previousSegment: SegmentView | null;
  segment: SegmentView;
  words: TranscriptData["words"] | null;
}) {
  const inMs = effectiveStart(segment);
  const outMs = effectiveEnd(segment);

  return (
    <li
      className="flex flex-col gap-2 rounded-md border p-3"
      data-segment-id={segment.id}
      data-testid="segment-item"
    >
      <button
        className="flex w-full cursor-pointer flex-col items-start gap-1 text-left"
        data-end-ms={outMs}
        data-start-ms={inMs}
        data-testid="segment-card"
        onClick={onPlay}
        type="button"
      >
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs tabular-nums">
            Ch {position}
          </span>
          <span className="font-medium text-sm">
            {segment.title ?? "Untitled segment"}
          </span>
          {segment.flags
            .filter((flag) => flag !== "gap_fill")
            .map((flag) => (
              <Badge data-testid="segment-flag" key={flag} variant="outline">
                {FLAG_LABELS[flag] ?? flag}
              </Badge>
            ))}
          {segment.reviewFlagged ? (
            <Badge data-testid="segment-review-flag" variant="outline">
              {REVIEW_FIX_LABELS[segment.reviewFix ?? "none"] ??
                "Reviewer: check"}
            </Badge>
          ) : null}
        </span>
        {segment.hook ? (
          <span className="text-muted-foreground text-sm">{segment.hook}</span>
        ) : null}
        <span className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs tabular-nums">
          <span>
            {stamp(inMs)}–{stamp(outMs)}
          </span>
          <Badge variant="secondary">{formatMinutes(outMs - inMs)}</Badge>
        </span>
        {segment.summary ? (
          <span className="line-clamp-2 text-muted-foreground text-xs">
            {segment.summary}
          </span>
        ) : null}
        {segment.reviewFlagged && segment.reviewNotes ? (
          <span
            className="line-clamp-2 text-muted-foreground text-xs italic"
            data-testid="segment-review-notes"
          >
            {segment.reviewNotes}
          </span>
        ) : null}
      </button>
      <SegmentNudges
        nextSegment={nextSegment}
        onPlayFrom={onPlayFrom}
        previousSegment={previousSegment}
        segment={segment}
        words={words}
      />
      <SegmentMergeActions
        nextSegment={nextSegment}
        previousSegment={previousSegment}
        segment={segment}
      />
      <SegmentMetadataEditor segment={segment} />
      <SegmentDecisions segment={segment} />
    </li>
  );
}

function planReadout(segments: readonly SegmentView[]): string {
  const keeps = segments.filter((segment) => segment.kind === "keep");
  const keptMs = keeps.reduce(
    (total, segment) =>
      total + (effectiveEnd(segment) - effectiveStart(segment)),
    0
  );
  const droppedMs = segments
    .filter((segment) => segment.kind === "drop")
    .reduce(
      (total, segment) =>
        total + (effectiveEnd(segment) - effectiveStart(segment)),
      0
    );
  const accepted = keeps.filter((s) => s.status === "accepted").length;
  const rejected = keeps.filter((s) => s.status === "rejected").length;
  const decisions =
    accepted + rejected > 0
      ? ` · ${accepted} accepted · ${rejected} rejected`
      : "";
  return `${keeps.length} chapters (${formatMinutes(keptMs)}) · dropped ${formatMinutes(droppedMs)}${decisions}`;
}

function SegmentsStateCard({
  children,
  description,
}: {
  children?: React.ReactNode;
  description: string;
}) {
  return (
    <Card data-testid="segments-panel">
      <CardHeader>
        <CardTitle>Segment clips</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children ? (
        <CardContent className="flex flex-col gap-2">{children}</CardContent>
      ) : null}
    </Card>
  );
}

export function SegmentsPanel({
  playback,
  run,
  segments,
  sourceId,
  transcriptUrl,
}: {
  playback: RangePlayback;
  run: SegmentsRun;
  segments: SegmentView[];
  sourceId: string;
  transcriptUrl: string | null;
}) {
  if (run.status === "missing") {
    return (
      <SegmentsStateCard description="Break this episode into chapter clips — a chronological plan that accounts for every second, with drops explained.">
        <PlanSegmentsButton
          label="Plan segment clips"
          sourceId={sourceId}
          testId="plan-segments"
        />
      </SegmentsStateCard>
    );
  }
  if (run.status === "pending" || run.status === "processing") {
    return (
      <SegmentsStateCard description="Planning the episode's chapters… This page updates automatically." />
    );
  }
  if (run.status === "failed") {
    return (
      <SegmentsStateCard description="Segment planning failed. You can run it again.">
        {run.error ? (
          <p className="break-words text-muted-foreground text-xs">
            {run.error}
          </p>
        ) : null}
        <PlanSegmentsButton sourceId={sourceId} />
      </SegmentsStateCard>
    );
  }
  return (
    <SegmentsReady
      error={run.error}
      playback={playback}
      segments={segments}
      sourceId={sourceId}
      stale={run.stale}
      transcriptUrl={transcriptUrl}
    />
  );
}

function SegmentsReady({
  error,
  playback,
  segments,
  sourceId,
  stale,
  transcriptUrl,
}: {
  error: string | null;
  playback: RangePlayback;
  segments: SegmentView[];
  sourceId: string;
  stale: boolean;
  transcriptUrl: string | null;
}) {
  const [words, setWords] = useState<TranscriptData["words"] | null>(null);

  // Same privately-cached object the transcript panel fetches.
  useEffect(() => {
    setWords(null);
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
        if (!cancelled) {
          // Nudges stay disabled; playback and decisions are unaffected.
          setWords(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [transcriptUrl]);

  // Card clicks play the chapter with 3s of lead-in and pause at the
  // out-point; play-from-in-point skips the lead-in but keeps the stop.
  const onPlay = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const startMs = Number(event.currentTarget.dataset.startMs);
      const endMs = Number(event.currentTarget.dataset.endMs);
      if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
        playback.playRange(Math.max(0, startMs - PLAY_PREROLL_MS), endMs);
      }
    },
    [playback]
  );
  const onPlayFrom = useCallback(
    (startMs: number, endMs: number) => {
      playback.playRange(startMs, endMs);
    },
    [playback]
  );

  const ordered = useMemo(
    () => [...segments].sort((a, b) => a.idx - b.idx),
    [segments]
  );
  let keepPosition = 0;

  return (
    <Card data-testid="segments-panel">
      <CardHeader>
        <CardTitle>Segment clips</CardTitle>
        <CardDescription>
          {segments.length > 0 ? (
            <span data-testid="segments-readout">{planReadout(segments)}</span>
          ) : (
            "The plan came back empty — run it again."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? (
          <div
            aria-live="polite"
            className="rounded-md border border-destructive/25 bg-destructive/5 p-3"
            data-testid="segment-rerun-preserved"
            role="status"
          >
            <p className="font-medium text-sm">
              The latest planning attempt failed. Your previous segments and
              reviews are unchanged.
            </p>
            <p className="mt-1 break-words text-muted-foreground text-xs">
              {error}
            </p>
          </div>
        ) : null}
        {stale ? (
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
            <span>This chapter plan is out of date for this source.</span>
            <PlanSegmentsButton sourceId={sourceId} />
          </div>
        ) : null}
        <ol className="flex flex-col gap-2">
          {ordered.map((segment, index) => {
            if (segment.kind === "drop") {
              return <DropRow key={segment.id} segment={segment} />;
            }
            keepPosition += 1;
            return (
              <KeepCard
                key={segment.id}
                nextSegment={ordered[index + 1] ?? null}
                onPlay={onPlay}
                onPlayFrom={onPlayFrom}
                position={keepPosition}
                previousSegment={ordered[index - 1] ?? null}
                segment={segment}
                words={words}
              />
            );
          })}
        </ol>
        <PlanSegmentsButton sourceId={sourceId} />
      </CardContent>
    </Card>
  );
}
