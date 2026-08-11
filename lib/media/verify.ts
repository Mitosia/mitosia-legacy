import { runMediaCommand } from "./ffmpeg";

// Output verification. Reconnect flags (see ffmpeg.ts) make a truncated read
// unlikely; this makes it impossible to ship silently. A transcode that
// covers less of the source than it should fails the ingest instead of
// reaching "ready", so the source row carries an error and the existing
// retry button is a real remedy.
//
// Nothing compared transcode output against the probed duration before this,
// which is why the S2 exit test produced a source marked ready with 41.8% of
// its video missing: probe wrote 7200s to the DB (Details said 2:00:00) while
// the player read 69:48 from the playlist, and the two numbers never met.

export class TruncatedOutputError extends Error {
  readonly actualSeconds: number;
  readonly expectedSeconds: number;

  constructor(label: string, actualSeconds: number, expectedSeconds: number) {
    const pct = ((actualSeconds / expectedSeconds) * 100).toFixed(1);
    super(
      `${label} covers ${actualSeconds.toFixed(1)}s of a ${expectedSeconds.toFixed(1)}s source (${pct}%) — the transcode was truncated, most likely a dropped read from storage`
    );
    this.name = "TruncatedOutputError";
    this.actualSeconds = actualSeconds;
    this.expectedSeconds = expectedSeconds;
  }
}

// Tolerance has to absorb legitimate variance — a video stream that ends
// slightly before the container duration, VFR sources, a short final
// segment — without absorbing real loss. 1% of a 2h source is 72s, against
// an observed real failure of 3011s.
const MIN_TOLERANCE_SECONDS = 12;
const TOLERANCE_FRACTION = 0.01;

export function durationTolerance(expectedSeconds: number): number {
  return Math.max(MIN_TOLERANCE_SECONDS, expectedSeconds * TOLERANCE_FRACTION);
}

// Sum of #EXTINF durations — the real playable length of an HLS variant,
// which is what the player reports and what disagreed with the DB.
export function sumPlaylistSeconds(playlist: string): number {
  let total = 0;
  for (const match of playlist.matchAll(/^#EXTINF:\s*([0-9.]+)/gm)) {
    total += Number.parseFloat(match[1] ?? "0");
  }
  return total;
}

export function assertCoversDuration(
  label: string,
  actualSeconds: number,
  expectedSeconds: number
): void {
  if (expectedSeconds <= 0) {
    return;
  }
  if (actualSeconds < expectedSeconds - durationTolerance(expectedSeconds)) {
    throw new TruncatedOutputError(label, actualSeconds, expectedSeconds);
  }
}

// Duration of a finished local artifact. Deliberately not probeSource():
// that one validates stream shape for ladder planning, this only needs the
// container duration of something we just wrote.
export async function probeDurationSeconds(path: string): Promise<number> {
  const { stdout } = await runMediaCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}
