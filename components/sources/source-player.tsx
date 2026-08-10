"use client";

import "@videojs/react/video/skin.css";
import { createPlayer } from "@videojs/react";
import { HlsJsVideo } from "@videojs/react/media/hlsjs-video";
import { VideoSkin, videoFeatures } from "@videojs/react/video";
import type { PeaksInstance } from "peaks.js";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";

// Proxy playback (Video.js v10 React over its hls.js engine) with waveform
// scrubbing (peaks.js on the precomputed peaks JSON — no client-side audio
// decode). Everything loads through /api/media, so auth is enforced per
// request.
//
// Two ordering rules keep this component alive — both were learned the
// hard way, change them only with the e2e green:
//
// 1. The player mounts CLIENT-ONLY (placeholder during SSR/hydration).
//    peaks.js touches `window` at module scope, so it is imported
//    dynamically and must never evaluate on the server; the Video.js media
//    element is a custom-element host, which we keep out of hydration's way
//    the same way media-chrome was.
// 2. peaks.js initializes BEFORE the hls.js engine attaches. Its init calls
//    mediaElement.load() when readyState is HAVE_NOTHING — inert while the
//    video has no source, but fatal after an MSE attach, because
//    MediaSource object URLs are single-use: a second load() re-requests a
//    revoked blob URL and kills playback (net::ERR_FILE_NOT_FOUND). The
//    engine is gated by keeping HlsJsVideo's `src` empty until peaks is up.

// Neutral in light mode, visible in dark; the played region uses the
// product accent family. The same accent themes the Video.js skin.
const WAVEFORM_COLOR = "#94a3b8";
const PLAYED_COLOR = "#6366f1";
const PLAYHEAD_COLOR = "#6366f1";

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

const SKIN_STYLE = { "--media-color-primary": PLAYED_COLOR } as CSSProperties;

const Player = createPlayer({ features: videoFeatures });

interface SourcePlayerProps {
  hlsUrl: string;
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

// Stage 1 of the player effect: peaks.js registers its listeners against
// the still source-less video (see ordering rule 2 above).
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
    Peaks.init(
      {
        dataUri: { json: setup.peaksUrl },
        keyboard: false,
        mediaElement: setup.video,
        overview: {
          container: setup.container,
          highlightColor: "transparent",
          playedWaveformColor: PLAYED_COLOR,
          playheadColor: PLAYHEAD_COLOR,
          showAxisLabels: false,
          waveformColor: WAVEFORM_COLOR,
        },
      },
      (error, peaks) => {
        if (setup.isCancelled()) {
          peaks?.destroy();
          return;
        }
        if (error) {
          // Surface the reason — a silently hidden waveform is undebuggable.
          console.error("[waveform] init failed:", error);
          setup.onError();
          return;
        }
        if (peaks) {
          setup.onReady(peaks);
        }
      }
    );
  } catch (error) {
    console.error("[waveform] init threw:", error);
    setup.onError();
  }
}

export function SourcePlayer({
  hlsUrl,
  peaksUrl,
  posterUrl,
}: SourcePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overviewRef = useRef<HTMLDivElement | null>(null);
  const [waveformError, setWaveformError] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Empty until peaks is bound — the hls.js engine only attaches once this
  // becomes the real URL (ordering rule 2).
  const [mediaSrc, setMediaSrc] = useState("");

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

    const logMediaError = () => {
      // Playback failures must be diagnosable from logs alone (the e2e
      // collects console errors on failure).
      console.error(
        `[player] media error ${video.error?.code ?? "?"}:`,
        video.error?.message ?? "(no message)"
      );
    };
    video.addEventListener("error", logMediaError);

    (async () => {
      if (peaksUrl && container) {
        await initWaveform({
          container,
          isCancelled: () => cancelled,
          onError: () => setWaveformError(true),
          onReady: (peaks) => {
            peaksInstance = peaks;
          },
          peaksUrl,
          video,
        });
      }

      if (cancelled) {
        return;
      }

      // Stage 2: attach playback — the engine loads once src is non-empty.
      setMediaSrc(hlsUrl);
    })();

    return () => {
      cancelled = true;
      video.removeEventListener("error", logMediaError);
      peaksInstance?.destroy();
    };
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
    <div className="flex flex-col gap-3">
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
            src={mediaSrc}
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
