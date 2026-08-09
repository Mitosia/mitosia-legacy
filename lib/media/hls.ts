import type { SourceProbe } from "./probe";

// Proxy-first HLS ladder: cheap renditions every editor and preview runs
// on. One ffmpeg invocation decodes the source once and encodes every
// variant; the master playlist is written by us afterwards from measured
// output sizes, which sidesteps var_stream_map's fragility entirely.

export const HLS_SEGMENT_SECONDS = 6;
// Proxy ladder heights, best first. Not archival quality — proxies.
const LADDER_HEIGHTS = [720, 360];
const AUDIO_BITRATE = "128k";

export interface HlsVariantPlan {
  // Output directory name under hls/ (v0, v1, …)
  dirName: string;
  height?: number;
  kind: "audio" | "video";
  width?: number;
}

function evenScaledWidth(
  probe: {
    height: number;
    width: number;
  },
  targetHeight: number
): number {
  // Mirrors ffmpeg's scale=-2:h — proportional width rounded to even.
  return Math.round((probe.width * targetHeight) / probe.height / 2) * 2;
}

export function planHlsLadder(probe: SourceProbe): HlsVariantPlan[] {
  if (probe.video) {
    const { video } = probe;
    const heights = LADDER_HEIGHTS.filter((height) => height <= video.height);
    if (heights.length === 0) {
      // Source smaller than the whole ladder: single passthrough-size rung.
      heights.push(video.height % 2 === 0 ? video.height : video.height - 1);
    }
    return heights.map((height, index) => ({
      dirName: `v${index}`,
      height,
      kind: "video",
      width: evenScaledWidth(video, height),
    }));
  }

  // Audio-only sources (podcast episodes) still get an HLS proxy so the
  // same player path serves them.
  return [{ dirName: "v0", kind: "audio" }];
}

export function buildHlsArgs(
  inputUrl: string,
  plan: HlsVariantPlan[],
  hasAudio: boolean,
  outDir: string
): string[] {
  const args = ["-v", "error", "-y", "-i", inputUrl];

  for (const variant of plan) {
    if (variant.kind === "video") {
      args.push("-map", "0:v:0");
      if (hasAudio) {
        args.push("-map", "0:a:0");
      }
      args.push(
        "-vf",
        `scale=-2:${variant.height}`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        // Force a keyframe on every segment boundary so segments cut clean.
        "-force_key_frames",
        `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`
      );
      if (hasAudio) {
        args.push("-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "2");
      }
    } else {
      args.push("-map", "0:a:0", "-c:a", "aac", "-b:a", AUDIO_BITRATE);
    }

    args.push(
      "-f",
      "hls",
      "-hls_time",
      String(HLS_SEGMENT_SECONDS),
      "-hls_playlist_type",
      "vod",
      "-hls_segment_filename",
      `${outDir}/${variant.dirName}/seg%05d.ts`,
      `${outDir}/${variant.dirName}/index.m3u8`
    );
  }

  return args;
}

export interface MasterPlaylistEntry {
  // Measured bits/second of the finished variant
  bandwidth: number;
  height?: number;
  // Relative playlist path, e.g. v0/index.m3u8
  path: string;
  width?: number;
}

export function renderMasterPlaylist(entries: MasterPlaylistEntry[]): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const entry of entries) {
    const attributes = [
      `BANDWIDTH=${Math.max(1, Math.round(entry.bandwidth))}`,
    ];
    if (entry.width && entry.height) {
      attributes.push(`RESOLUTION=${entry.width}x${entry.height}`);
    }
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`, entry.path);
  }
  return `${lines.join("\n")}\n`;
}
