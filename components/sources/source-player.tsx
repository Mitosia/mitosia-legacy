"use client";

import "@videojs/react/video/skin.css";
import "./source-player.css";
import { createPlayer } from "@videojs/react";
import { HlsJsVideo } from "@videojs/react/media/hlsjs-video";
import { VideoSkin, videoFeatures } from "@videojs/react/video";
import type {
  EventEmitterForPlayerEvents,
  PeaksInstance,
  PlayerAdapter,
} from "peaks.js";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";

// Proxy playback (Video.js v10 React over its hls.js engine) with waveform
// scrubbing (peaks.js on the precomputed peaks JSON — no client-side audio
// decode). Everything loads through /api/media, so auth is enforced per
// request.
//
// Three rules keep this component alive — all learned the hard way,
// change them only with the e2e green:
//
// 1. The player mounts CLIENT-ONLY (placeholder during SSR/hydration).
//    peaks.js touches `window` at module scope, so it is imported
//    dynamically and must never evaluate on the server; the Video.js media
//    element is a custom-element host, which we keep out of hydration's way
//    the same way media-chrome was.
// 2. peaks.js talks to the media element ONLY through the passive adapter
//    below — never its default MediaElementPlayer. The Video.js engine
//    attaches MediaSource at MOUNT (a blob src appears before any src
//    prop), and dev StrictMode double-mounts it: attach → revoke → media
//    error → reattach. MediaElementPlayer.init inspects the element mid-
//    churn — a sourced element triggers mediaElement.load() (re-requests
//    a revoked, single-use blob URL: net::ERR_FILE_NOT_FOUND) and a
//    transiently errored one rejects init with MediaError, hiding the
//    waveform. No src-gating can fix that — the attach precedes any src —
//    so the adapter simply never loads, never inspects source state, and
//    only forwards events; ordering between peaks and the engine stops
//    mattering, and the engine may start loading immediately.
// 3. playedWaveformColor is applied on durationchange, never at
//    Peaks.init. peaks.js splits the waveform into played/unplayed
//    shapes and captures player.getDuration() ONCE when the split is
//    created; duration is still NaN while metadata is loading, which
//    froze the unplayed range at 0→NaN — the strip rendered fully blank
//    on load and nothing right of the playhead could ever paint, in dev
//    and production builds alike (peaks.js 4.0.0 has no durationchange
//    handling). Splitting only once the duration is real keeps every
//    region drawable, and the pre-split single shape paints the full
//    strip immediately.

// Neutral in light mode, visible in dark; the waveform's played region
// uses the product accent family. The player chrome itself stays white
// (Rajesh, 2026-08-10) — the accent lives in the waveform only.
const WAVEFORM_COLOR = "#94a3b8";
const PLAYED_COLOR = "#6366f1";
const PLAYHEAD_COLOR = "#6366f1";
const CONTROLS_COLOR = "#ffffff";

// hls.js assumes 500 kbps until measured, which would pin startup to the
// lowest rung. A review tool must start at review quality: this estimate
// exceeds every ladder top rung, so the auto start level picks the top
// rendition; ABR still steps down if the connection genuinely can't keep
// up. (The previous player also forced startLevel to the top at manifest
// parse — with this estimate the auto pick lands on the same rung.)
const STARTUP_BANDWIDTH_ESTIMATE = 10_000_000;

// Module-level so the identity is stable: reassigning `config` reloads the
// hls.js engine.
const HLS_CONFIG = {
  hlsJs: { abrEwmaDefaultEstimate: STARTUP_BANDWIDTH_ESTIMATE },
};

const SKIN_STYLE = {
  "--media-color-primary": CONTROLS_COLOR,
} as CSSProperties;

const Player = createPlayer({ features: videoFeatures });

interface SourcePlayerProps {
  hlsUrl: string;
  // Hands the mounted media element to a sibling consumer (the transcript
  // panel) and null on unmount. Consumers follow the same passive contract
  // as the peaks adapter: read state, add/remove their own listeners, set
  // currentTime — never load() and never inspect source/error state.
  onVideoElement?: (video: HTMLVideoElement | null) => void;
  peaksUrl: string | null;
  posterUrl: string | null;
}

interface WaveformSetup {
  container: HTMLDivElement;
  isCancelled: () => boolean;
  onError: () => void;
  onReady: (peaks: PeaksInstance) => void;
  peaksUrl: string;
  video: HTMLVideoElement;
}

// Ordering rule 2: a passive stand-in for peaks' MediaElementPlayer.
// Forwards the DOM events peaks needs and proxies transport queries, but
// never calls load() and never inspects source state, so the Video.js
// engine's MSE attach/detach churn cannot fail peaks' init. 'player.error'
// is deliberately not forwarded: transient engine churn raises media
// errors that mean nothing to peaks (nothing subscribes), and real
// failures are logged by the component's own error listener.
function createPassiveAdapter(video: HTMLVideoElement): PlayerAdapter {
  let removeListeners: (() => void) | undefined;
  return {
    destroy: () => {
      removeListeners?.();
      removeListeners = undefined;
    },
    getCurrentTime: () => video.currentTime,
    getDuration: () => video.duration,
    init: (eventEmitter: EventEmitterForPlayerEvents) => {
      const forwarded: [string, () => void][] = [
        [
          "timeupdate",
          () => eventEmitter.emit("player.timeupdate", video.currentTime),
        ],
        [
          "playing",
          () => eventEmitter.emit("player.playing", video.currentTime),
        ],
        ["pause", () => eventEmitter.emit("player.pause", video.currentTime)],
        ["ended", () => eventEmitter.emit("player.ended")],
        ["seeked", () => eventEmitter.emit("player.seeked", video.currentTime)],
        ["canplay", () => eventEmitter.emit("player.canplay")],
      ];
      for (const [type, listener] of forwarded) {
        video.addEventListener(type, listener);
      }
      removeListeners = () => {
        for (const [type, listener] of forwarded) {
          video.removeEventListener(type, listener);
        }
      };
      return Promise.resolve();
    },
    isPlaying: () => !video.paused,
    isSeeking: () => video.seeking,
    pause: () => {
      video.pause();
    },
    play: () => video.play(),
    seek: (time: number) => {
      video.currentTime = time;
    },
  };
}

// Peaks.init throws if the overview container has no layout yet, which
// happens when the route hydrates in a hidden or zero-sized context
// (background tab, prerender, hidden preview pane) — and a failed init used
// to hide the waveform for good. Wait until the container actually has a
// width; on hidden tabs rAF is throttled or paused, so this simply resumes
// when the page becomes visible. Only cancellation ends the wait early.
function waitForLayout(
  container: HTMLElement,
  isCancelled: () => boolean
): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (isCancelled() || container.clientWidth > 0) {
        resolve();
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}

// Binds peaks.js to the media element through the passive adapter (rule
// 2). Resolves once Peaks.init's callback has fired (or setup threw), so
// callers can sequence follow-up work after init settles.
async function initWaveform(setup: WaveformSetup): Promise<void> {
  try {
    const { default: Peaks } = await import("peaks.js");
    if (setup.isCancelled()) {
      return;
    }
    await waitForLayout(setup.container, setup.isCancelled);
    if (setup.isCancelled()) {
      return;
    }
    await new Promise<void>((resolve) => {
      Peaks.init(
        {
          dataUri: { json: setup.peaksUrl },
          keyboard: false,
          overview: {
            container: setup.container,
            highlightColor: "transparent",
            playheadColor: PLAYHEAD_COLOR,
            showAxisLabels: false,
            waveformColor: WAVEFORM_COLOR,
          },
          player: createPassiveAdapter(setup.video),
        },
        (error, peaks) => {
          try {
            if (setup.isCancelled()) {
              peaks?.destroy();
            } else if (error) {
              // Surface the reason — a silently hidden waveform is
              // undebuggable.
              console.error("[waveform] init failed:", error);
              setup.onError();
            } else if (peaks) {
              setup.onReady(peaks);
            }
          } finally {
            resolve();
          }
        }
      );
    });
  } catch (error) {
    console.error("[waveform] init threw:", error);
    setup.onError();
  }
}

export function SourcePlayer({
  hlsUrl,
  onVideoElement,
  peaksUrl,
  posterUrl,
}: SourcePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overviewRef = useRef<HTMLDivElement | null>(null);
  const [waveformError, setWaveformError] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const container = overviewRef.current;
    if (!(mounted && video)) {
      return;
    }

    let cancelled = false;
    let peaksInstance: PeaksInstance | undefined;
    let removePlayedColorListener: (() => void) | undefined;

    onVideoElement?.(video);

    const logMediaError = () => {
      // Playback failures must be diagnosable from logs alone (the e2e
      // collects console errors on failure).
      console.error(
        `[player] media error ${video.error?.code ?? "?"}:`,
        video.error?.message ?? "(no message)"
      );
    };
    video.addEventListener("error", logMediaError);

    if (peaksUrl && container) {
      initWaveform({
        container,
        isCancelled: () => cancelled,
        onError: () => setWaveformError(true),
        onReady: (peaks) => {
          peaksInstance = peaks;
          // Ordering rule 3: create the played/unplayed split only
          // once the media duration is real. Not `once: true` — the
          // guard must survive a durationchange that reports a
          // non-finite duration.
          const applyPlayedColor = () => {
            if (cancelled || !Number.isFinite(video.duration)) {
              return;
            }
            video.removeEventListener("durationchange", applyPlayedColor);
            peaks.views
              .getView("overview")
              ?.setPlayedWaveformColor(PLAYED_COLOR);
          };
          video.addEventListener("durationchange", applyPlayedColor);
          removePlayedColorListener = () =>
            video.removeEventListener("durationchange", applyPlayedColor);
          applyPlayedColor();
        },
        peaksUrl,
        video,
      });
    }

    return () => {
      cancelled = true;
      onVideoElement?.(null);
      video.removeEventListener("error", logMediaError);
      removePlayedColorListener?.();
      peaksInstance?.destroy();
    };
    // onVideoElement deliberately not a dependency: parents pass state
    // setters, and re-running this effect (peaks teardown + reinit) on a
    // parent render would be the churn rule 2 exists to avoid.
  }, [hlsUrl, peaksUrl, mounted]);

  if (!mounted) {
    // Server-rendered placeholder: same footprint as the player, poster
    // visible, zero interactive DOM for hydration to fight over.
    return (
      <div className="flex flex-col gap-3">
        <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
          {posterUrl ? (
            <img
              alt=""
              className="h-full w-full object-contain"
              height={720}
              src={posterUrl}
              width={1280}
            />
          ) : null}
        </div>
        {peaksUrl ? (
          <div className="h-24 w-full rounded-md border bg-muted/30" />
        ) : null}
      </div>
    );
  }

  return (
    <div className="source-player flex flex-col gap-3">
      <Player.Provider>
        <VideoSkin
          className="aspect-video w-full overflow-hidden rounded-md"
          poster={posterUrl ?? undefined}
          style={SKIN_STYLE}
        >
          <HlsJsVideo
            config={HLS_CONFIG}
            crossOrigin="use-credentials"
            preload="metadata"
            ref={videoRef}
            src={hlsUrl}
            streamType="on-demand"
          />
        </VideoSkin>
      </Player.Provider>
      {peaksUrl && !waveformError ? (
        <div
          aria-label="Audio waveform — click to seek"
          className="h-24 w-full rounded-md border bg-muted/30"
          data-testid="waveform-overview"
          ref={overviewRef}
          role="img"
        />
      ) : null}
    </div>
  );
}
