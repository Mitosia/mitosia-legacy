import { ffmpeg } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

// Trigger.dev is the durable outer spine for ingest/render/publish jobs
// (tech-stack §8). Deploying needs TRIGGER_PROJECT_REF + TRIGGER_SECRET_KEY
// (and the STORAGE_*/DATABASE_URL env in the Trigger dashboard). Until the
// project is provisioned, local dev and staging fall back to the in-process
// runner in lib/ingest.ts.
export default defineConfig({
  build: {
    extensions: [ffmpeg()],
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
