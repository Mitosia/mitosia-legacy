import { spawn } from "node:child_process";

// Thin process wrapper for ffmpeg/ffprobe. Media work happens in temp dirs
// on the worker (Trigger.dev machine or, in dev, the app process); inputs
// stream straight from presigned storage URLs.

const STDERR_TAIL_BYTES = 4096;

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
