"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

// One armed out-point shared by every panel: the workspace owns the single
// hook instance and hands `playRange` down, so clicking a moment, segment,
// highlight, or citation plays that span and PAUSES at its out-point — the
// reviewer hears exactly where the clip ends instead of the video running on.
//
// Contract:
// - The stop is single-shot: it fires once, then disarms.
// - Any seek this hook did not initiate disarms it — a scrub, a transcript
//   word, or a chapter click means the human took over the timeline.
// - Arming lives in a ref, never state: timeupdate fires ~4×/s and must not
//   re-render the workspace.

export interface RangePlayback {
  /** Seek to startMs and play with no out-point — disarms any pending stop. */
  playFrom: (startMs: number) => void;
  /** Seek to fromMs, play, and pause when playback reaches stopAtMs. */
  playRange: (fromMs: number, stopAtMs: number) => void;
}

export function useRangePlayback(
  video: HTMLVideoElement | null
): RangePlayback {
  const stopAtMsRef = useRef<number | null>(null);
  const ownSeekRef = useRef<boolean>(false);

  useEffect(() => {
    if (!video) {
      return;
    }
    const onTimeUpdate = () => {
      const stopAtMs = stopAtMsRef.current;
      if (stopAtMs === null || video.seeking) {
        return;
      }
      if (video.currentTime * 1000 >= stopAtMs) {
        stopAtMsRef.current = null;
        video.pause();
        // timeupdate granularity overshoots by up to ~250ms; land the
        // paused frame exactly on the out-point.
        ownSeekRef.current = true;
        video.currentTime = stopAtMs / 1000;
      }
    };
    const onSeeking = () => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: playRange/playFrom flip this ref in other closures; biome's flow analysis misses ref mutations
      if (ownSeekRef.current) {
        ownSeekRef.current = false;
        return;
      }
      stopAtMsRef.current = null;
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeking", onSeeking);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeking", onSeeking);
    };
  }, [video]);

  const playRange = useCallback(
    (fromMs: number, stopAtMs: number) => {
      if (!video) {
        return;
      }
      ownSeekRef.current = true;
      stopAtMsRef.current = stopAtMs > fromMs ? stopAtMs : null;
      video.currentTime = fromMs / 1000;
      video.play().catch(() => {
        // Autoplay policies can refuse; the seek alone still lands
      });
    },
    [video]
  );

  const playFrom = useCallback(
    (startMs: number) => {
      if (!video) {
        return;
      }
      ownSeekRef.current = true;
      stopAtMsRef.current = null;
      video.currentTime = startMs / 1000;
      video.play().catch(() => {
        // Autoplay policies can refuse; the seek alone still lands
      });
    },
    [video]
  );

  return useMemo(() => ({ playFrom, playRange }), [playFrom, playRange]);
}
