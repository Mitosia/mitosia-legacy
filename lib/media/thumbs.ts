import { inputArgs, runMediaCommand } from "./ffmpeg";

// Poster frame + a sparse thumbnail strip for scrubbing and list cards.

const POSTER_WIDTH = 1280;
const THUMB_WIDTH = 320;
// Cap the strip at ~120 images regardless of source length.
const MAX_THUMBNAILS = 120;
const MIN_INTERVAL_SECONDS = 10;

export function thumbnailIntervalSeconds(durationSeconds: number): number {
  return Math.max(
    MIN_INTERVAL_SECONDS,
    Math.ceil(durationSeconds / MAX_THUMBNAILS)
  );
}

// Filter strings are exported and unit-tested because both pinned args fix
// observed ffmpeg 8 failures (see tests/thumbnail-filters.test.ts):
// - format=yuvj420p — the mjpeg encoder refuses limited-range YUV (hard
//   error: "Non full-range YUV is non-standard")
// - fps=1/N:round=up — without it, sources shorter than N seconds emit
//   ZERO thumbnails with exit code 0 (silent failure)

export function posterFilter(): string {
  return `scale=${POSTER_WIDTH}:-2,format=yuvj420p`;
}

export function thumbnailStripFilter(intervalSeconds: number): string {
  return `fps=1/${intervalSeconds}:round=up,scale=${THUMB_WIDTH}:-2,format=yuvj420p`;
}

export async function generatePoster(
  inputUrl: string,
  durationSeconds: number,
  outPath: string
): Promise<void> {
  // A quarter of the way in dodges black lead-ins and title cards.
  const seekTo = Math.min(durationSeconds * 0.25, 30);
  await runMediaCommand("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-ss",
    seekTo.toFixed(2),
    ...inputArgs(inputUrl),
    "-frames:v",
    "1",
    "-vf",
    posterFilter(),
    outPath,
  ]);
}

export async function generateThumbnailStrip(
  inputUrl: string,
  durationSeconds: number,
  outDir: string
): Promise<{ intervalSeconds: number }> {
  const intervalSeconds = thumbnailIntervalSeconds(durationSeconds);
  await runMediaCommand("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...inputArgs(inputUrl),
    "-vf",
    thumbnailStripFilter(intervalSeconds),
    `${outDir}/thumb%05d.jpg`,
  ]);
  return { intervalSeconds };
}
