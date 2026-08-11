import { spawn } from "node:child_process";

// Thin process wrapper for ffmpeg/ffprobe. Media work happens in temp dirs
// on the worker (Trigger.dev machine or, in dev, the app process); inputs
// stream straight from presigned storage URLs.

const STDERR_TAIL_BYTES = 4096;

// Reconnect settings for remote inputs. ffmpeg's HTTP reader treats a
// mid-transfer disconnect as end-of-file: it finalizes a VALID but truncated
// output and exits 0, so with `-v error` nothing anywhere looks wrong.
//
// The exposure is how LONG a read stays open, not how big it is. The HLS
// ladder is CPU-bound and holds one connection for the whole transcode — a
// 2h source at 0.26x realtime drains 2.1GB over ~28 minutes at ~1.2MB/s —
// and the S2 exit test came back with 58.2% of its video (4189s of 7200s)
// across all three rungs. The audio step read the same object end to end in
// ~2 minutes and was complete, which is what pinned the cause. Sub-5-minute
// files finish the read in seconds, which is why this hid through S2.
//
// `-reconnect` is precisely "auto reconnect after disconnect before EOF":
// ffmpeg knows Content-Length, notices the short read, and resumes with a
// ranged request. The retry caps bound a genuinely dead origin so a broken
// source fails instead of hanging forever.
//
// Keep this list to options that have been in ffmpeg for years. CI installs
// Ubuntu's apt ffmpeg while the Docker image installs Alpine's (8.1.2 on
// staging), so a flag that exists in one can be absent in the other — and an
// unknown option is a HARD failure that breaks every ingest, not a warning.
// `-reconnect_max_retries` was here initially and CI's ffprobe rejected it
// with "Option not found". `-reconnect_delay_max` already bounds giving up
// (the backoff doubles past 30s after ~6 attempts), so it added nothing.
const HTTP_RECONNECT_ARGS = [
  "-reconnect",
  "1",
  "-reconnect_streamed",
  "1",
  "-reconnect_on_network_error",
  "1",
  "-reconnect_delay_max",
  "30",
];

const HTTP_URL = /^https?:\/\//i;

// Input args for a source that may be a presigned URL or a local path.
// Always use this instead of a bare ["-i", url] — reconnect flags are input
// options and must precede -i. Local paths must not carry them: ffmpeg
// rejects http options on the file protocol ("Option reconnect not found").
export function inputArgs(input: string): string[] {
  if (!HTTP_URL.test(input)) {
    return ["-i", input];
  }
  return [...HTTP_RECONNECT_ARGS, "-i", input];
}

export class MediaCommandError extends Error {
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor(command: string, exitCode: number | null, stderrTail: string) {
    super(`${command} exited with code ${exitCode}: ${stderrTail.slice(-500)}`);
    this.name = "MediaCommandError";
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

interface RunOptions {
  // Receives raw stdout chunks as they arrive (used for PCM streaming);
  // when set, stdout is not buffered into the result.
  onStdout?: (chunk: Buffer) => void;
}

export function runMediaCommand(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    let stderrTail = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onStdout) {
        options.onStdout(chunk);
      } else {
        stdoutChunks.push(chunk);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `${command} is not installed or not on PATH — the ingest pipeline requires ffmpeg/ffprobe`
          )
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdoutChunks).toString() });
        return;
      }
      reject(new MediaCommandError(command, code, stderrTail));
    });
  });
}
