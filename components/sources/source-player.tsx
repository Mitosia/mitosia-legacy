"use client";

import Hls from "hls.js";
import {
  MediaControlBar,
  MediaController,
  MediaFullscreenButton,
  MediaMuteButton,
  MediaPlayButton,
  MediaPlaybackRateButton,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from "media-chrome/react";
import type { PeaksInstance } from "peaks.js";
import { useEffect, useRef, useState } from "react";

// Proxy playback (media-chrome over hls.js) with waveform scrubbing
// (peaks.js on the precomputed peaks JSON — no client-side audio decode).
// Everything loads through /api/media, so auth is enforced per request.
//
// Two ordering rules keep this component alive — both were learned the
// hard way, change them only with the e2e green:
//
// 1. The player mounts CLIENT-ONLY (placeholder during SSR/hydration).
//    media-chrome's custom elements rewrite their own DOM on upgrade,
//    which React hydration flags as a mismatch; and peaks.js touches
//    `window` at module scope, so it is imported dynamically and must
//    never evaluate on the server.
// 2. peaks.js initializes BEFORE hls attaches. Its init calls
//    mediaElement.load() when readyState is HAVE_NOTHING — inert while
//    the video has no source, but fatal after hls attaches, because
//    MediaSource object URLs are single-use: a second load() re-requests
//    a revoked blob URL and kills playback (net::ERR_FILE_NOT_FOUND).

// Neutral in light mode, visible in dark; the played region uses the
// product accent family.
const WAVEFORM_COLOR = "#94a3b8";
const PLAYED_COLOR = "#6366f1";
const PLAYHEAD_COLOR = "#6366f1";

// hls.js assumes 500 kbps until measured, which would pin startup to the
// lowest rung. A review tool must start at review quality; ABR still
// steps down if the connection genuinely can't keep up.
const STARTUP_BANDWIDTH_ESTIMATE = 10_000_000;

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
    let hls: Hls | undefined;
    let peaksInstance: PeaksInstance | undefined;

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

      // Stage 2: attach playback.
      if (Hls.isSupported()) {
        hls = new Hls({ abrEwmaDefaultEstimate: STARTUP_BANDWIDTH_ESTIMATE });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (hls) {
            // Start at the top rendition (levels are sorted by bitrate);
            // ABR takes over from the second fragment onward.
            hls.startLevel = hls.levels.length - 1;
          }
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            // Surfaced in the console (and collected by e2e) — playback
            // failures must be diagnosable from logs alone.
            console.error(
              `[hls] fatal ${data.type}: ${data.details}`,
              data.response?.code ?? ""
            );
          }
        });
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        return;
      }

      // Safari plays HLS natively.
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = hlsUrl;
      }
    })();

    return () => {
      cancelled = true;
      peaksInstance?.destroy();
      hls?.destroy();
      video.removeAttribute("src");
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
      <MediaController className="aspect-video w-full overflow-hidden rounded-md">
        {/* biome-ignore lint/a11y/useMediaCaption: caption tracks arrive with transcription (S3) */}
        <video
          crossOrigin="use-credentials"
          poster={posterUrl ?? undefined}
          ref={videoRef}
          slot="media"
        />
        <MediaControlBar>
          <MediaPlayButton />
          <MediaSeekBackwardButton seekOffset={10} />
          <MediaSeekForwardButton seekOffset={10} />
          <MediaTimeRange />
          <MediaTimeDisplay showDuration />
          <MediaMuteButton />
          <MediaVolumeRange />
          <MediaPlaybackRateButton />
          <MediaFullscreenButton />
        </MediaControlBar>
      </MediaController>
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
