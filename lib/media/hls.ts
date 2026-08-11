import { inputArgs, PROGRESS_ARGS } from "./ffmpeg";
import type { SourceProbe } from "./probe";

// Rendition ladder built on what the major platforms converged on:
//
// - Apple HLS authoring spec: 6s segments, keyframes every 2s, H.264 High
//   profile, and for VOD a peak bitrate no more than 200% of average —
//   implemented here as capped CRF (crf + maxrate + bufsize=2×maxrate).
// - Netflix per-title encoding: encode to a QUALITY target and let bitrate
//   follow content complexity instead of fixing bitrates per rung. Capped
//   CRF is the standard lightweight version of this (their convex-hull
//   trial-encode search needs an encoding farm; the caps bound the worst
//   case the same way their 200%-peak rule does).
// - YouTube: always serve a rung at the source's native resolution (capped
//   here at 1080p), and give ~1.5× bitrate headroom to high-fps sources.
//
// Deliberately NOT replicated at this stage: the 234p–480p cellular rungs
// (this ladder feeds a desktop review tool; add rows below when client
// delivery ships in S18) and multi-codec VP9/AV1 (an egress-cost play at
// YouTube scale; H.264 plays everywhere and hls.js handles it perfectly).

export const HLS_SEGMENT_SECONDS = 6;
// Apple authoring spec: keyframe every 2s — enables clean mid-stream
// quality switches and fine seek granularity. Must divide segment length.
export const HLS_KEYFRAME_SECONDS = 2;

const TOP_RUNG_MAX_HEIGHT = 1080;
const HIGH_FPS_THRESHOLD = 40;
const HIGH_FPS_MAXRATE_FACTOR = 1.5;
const AUDIO_BITRATE = "128k";

// The top rung carries review quality: tighter CRF, slower preset, and a
// cap chosen by resolution (Apple/industry 30fps figures).
const TOP_RUNG_CAPS_K: { maxrateK: number; minHeight: number }[] = [
  { maxrateK: 6000, minHeight: 1080 },
  { maxrateK: 4500, minHeight: 720 },
  { maxrateK: 2000, minHeight: 480 },
  { maxrateK: 1200, minHeight: 0 },
];

// Proxy rungs below the top: cheap to make, cheap to stream.
const PROXY_RUNGS = [
  { crf: 22, height: 720, maxrateK: 3000, preset: "veryfast" },
  { crf: 23, height: 360, maxrateK: 900, preset: "veryfast" },
];

const TOP_RUNG_CRF = 20;
const TOP_RUNG_PRESET = "fast";

export interface HlsVariantPlan {
  crf?: number;
  // Output directory name under hls/ (v0, v1, …)
  dirName: string;
  height?: number;
  kind: "audio" | "video";
  maxrateK?: number;
  preset?: string;
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

function topRungCapK(height: number): number {
  const row = TOP_RUNG_CAPS_K.find((entry) => height >= entry.minHeight);
  return row?.maxrateK ?? 1200;
}

export function planHlsLadder(probe: SourceProbe): HlsVariantPlan[] {
  if (probe.video) {
    const { video } = probe;
    // High-fps sources (60fps screen shares, gameplay) get bitrate
    // headroom, mirroring the 30→60fps step-up in Apple's and YouTube's
    // published figures.
    const fpsFactor =
      video.fps > HIGH_FPS_THRESHOLD ? HIGH_FPS_MAXRATE_FACTOR : 1;

    const topHeight = Math.min(
      video.height % 2 === 0 ? video.height : video.height - 1,
      TOP_RUNG_MAX_HEIGHT
    );

    const rungs = [
      {
        crf: TOP_RUNG_CRF,
        height: topHeight,
        maxrateK: Math.round(topRungCapK(topHeight) * fpsFactor),
        preset: TOP_RUNG_PRESET,
      },
      ...PROXY_RUNGS.filter((rung) => rung.height < topHeight).map((rung) => ({
        ...rung,
        maxrateK: Math.round(rung.maxrateK * fpsFactor),
      })),
    ];

    return rungs.map((rung, index) => ({
      crf: rung.crf,
      dirName: `v${index}`,
      height: rung.height,
      kind: "video" as const,
      maxrateK: rung.maxrateK,
      preset: rung.preset,
      width: evenScaledWidth(video, rung.height),
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
  // Progress on stdout: the ladder is the one step long enough that silence
  // reads as a hang. A 2h source spends ~30 minutes here, and with nothing
  // reported the UI sat on "Preparing playback" and the row's updated_at
  // never moved — a healthy ingest was indistinguishable from a dead one.
  const args = ["-v", "error", ...PROGRESS_ARGS, "-y", ...inputArgs(inputUrl)];

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
        // Apple authoring spec: High profile (not Baseline/Main)
        "-profile:v",
        "high",
        "-preset",
        variant.preset ?? "veryfast",
        "-crf",
        String(variant.crf ?? 23),
        // Capped CRF: quality-led encoding with the Apple VOD constraint
        // (peak ≤ 200% of average → bufsize = 2× maxrate)
        "-maxrate",
        `${variant.maxrateK}k`,
        "-bufsize",
        `${(variant.maxrateK ?? 0) * 2}k`,
        "-force_key_frames",
        `expr:gte(t,n_forced*${HLS_KEYFRAME_SECONDS})`
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

// Variants are written top-quality-first: native HLS players (Safari)
// default to the FIRST variant in the master playlist, so ordering is the
// Safari-side half of "start at review quality" (hls.js gets startLevel).
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
