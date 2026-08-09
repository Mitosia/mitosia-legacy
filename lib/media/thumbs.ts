import { runMediaCommand } from "./ffmpeg";

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
    "-i",
    inputUrl,
    "-frames:v",
    "1",
    // format=yuvj420p: ffmpeg 8's mjpeg encoder refuses limited-range YUV
    "-vf",
    `scale=${POSTER_WIDTH}:-2,format=yuvj420p`,
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
    "-i",
    inputUrl,
    // round=up: without it ffmpeg 8 emits zero frames when the source is
    // shorter than the sampling interval
    "-vf",
    `fps=1/${intervalSeconds}:round=up,scale=${THUMB_WIDTH}:-2,format=yuvj420p`,
    `${outDir}/thumb%05d.jpg`,
  ]);
  return { intervalSeconds };
}
