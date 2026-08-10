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
import Peaks, { type PeaksInstance } from "peaks.js";
import { useEffect, useRef, useState } from "react";

// Proxy playback (media-chrome over hls.js) with waveform scrubbing
// (peaks.js on the precomputed peaks JSON — no client-side audio decode).
// Everything loads through /api/media, so auth is enforced per request.

// Neutral in light mode, visible in dark; the played region uses the
// product accent family.
const WAVEFORM_COLOR = "#94a3b8";
const PLAYED_COLOR = "#6366f1";
const PLAYHEAD_COLOR = "#6366f1";

interface SourcePlayerProps {
  hlsUrl: string;
  peaksUrl: string | null;
  posterUrl: string | null;
}

export function SourcePlayer({
  hlsUrl,
  peaksUrl,
  posterUrl,
}: SourcePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overviewRef = useRef<HTMLDivElement | null>(null);
  const [waveformError, setWaveformError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: refs are null until mount; biome's inference misses RefObject nullability
    if (!video) {
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls();
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
      return () => hls.destroy();
    }

    // Safari plays HLS natively.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl;
      return () => {
        video.removeAttribute("src");
      };
    }
  }, [hlsUrl]);

  useEffect(() => {
    const video = videoRef.current;
    const container = overviewRef.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: refs are null until mount; biome's inference misses RefObject nullability
    if (!(video && container && peaksUrl)) {
      return;
    }

    let instance: PeaksInstance | undefined;
    let cancelled = false;

    Peaks.init(
      {
        dataUri: { json: peaksUrl },
        keyboard: false,
        mediaElement: video,
        overview: {
          container,
          highlightColor: "transparent",
          playedWaveformColor: PLAYED_COLOR,
          playheadColor: PLAYHEAD_COLOR,
          showAxisLabels: false,
          waveformColor: WAVEFORM_COLOR,
        },
      },
      (error, peaks) => {
        if (cancelled) {
          peaks?.destroy();
          return;
        }
        if (error) {
          setWaveformError(true);
          return;
        }
        instance = peaks;
      }
    );

    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [peaksUrl]);

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
