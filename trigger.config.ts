import type { BuildExtension } from "@trigger.dev/build";
import { defineConfig } from "@trigger.dev/sdk";
import { ffmpegInstallCommand } from "./scripts/ffmpeg-pin.mjs";

// NOT the bundled `ffmpeg()` extension. It installs Debian's apt ffmpeg
// (5.1.x), and its only alternative is a *floating* git build — neither is
// the 8.1.x minor `lib/media/` is written against and every other
// environment pins. That gap is not cosmetic: `-reconnect_on_network_error`
// (lib/media/ffmpeg.ts, the fix for silently truncated transcodes) landed in
// ffmpeg 6.1, and an unknown option makes ffmpeg refuse to start — so the
// first thing setting TRIGGER_SECRET_KEY would have done is break every
// ingest, on the runtime meant to make ingest more reliable.
//
// Installs the same checksummed asset CI does, then runs the shared version
// check so a drifted pin fails the deploy instead of the first upload.
function pinnedFfmpeg(): BuildExtension {
  return {
    name: "pinned-ffmpeg",
    onBuildComplete(context) {
      if (context.target === "dev") {
        return;
      }
      context.addLayer({
        deploy: {
          env: {
            FFMPEG_PATH: "/usr/bin/ffmpeg",
            FFPROBE_PATH: "/usr/bin/ffprobe",
          },
          override: true,
        },
        id: "ffmpeg",
        image: {
          instructions: [
            `RUN ${ffmpegInstallCommand()}`,
            "COPY scripts/check-ffmpeg-version.mjs /tmp/check-ffmpeg-version.mjs",
            "RUN node /tmp/check-ffmpeg-version.mjs && rm /tmp/check-ffmpeg-version.mjs",
          ],
        },
      });
    },
  };
}

// Trigger.dev is the durable outer spine for ingest/render/publish jobs
// (tech-stack §8). Deploying needs TRIGGER_PROJECT_REF + TRIGGER_SECRET_KEY
// (and the STORAGE_*/DATABASE_URL env in the Trigger dashboard). Until the
// project is provisioned, local dev and staging fall back to the in-process
// runner in lib/ingest.ts.
export default defineConfig({
  build: {
    extensions: [pinnedFfmpeg()],
  },
  dirs: ["./trigger"],
  // A two-hour source transcodes for a while even at veryfast; give the
  // task real headroom rather than failing at a default cap.
  maxDuration: 6 * 3600,
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_placeholder_until_s2_infra",
  retries: {
    default: {
      factor: 2,
      maxAttempts: 3,
      maxTimeoutInMs: 60_000,
      minTimeoutInMs: 5000,
      randomize: true,
    },
    enabledInDev: true,
  },
});
