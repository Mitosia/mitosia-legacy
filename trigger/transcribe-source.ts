import { task } from "@trigger.dev/sdk";
import { tuneOutboundConnections } from "@/lib/net-tuning";
import {
  runTranscription,
  type TranscriptionPayload,
} from "@/lib/transcription/pipeline";

// Every file under ./trigger opens its own database connection path and
// Next.js's register() hook never runs here — see trigger/ingest-source.ts
// for the full story. Module scope, before the first query.
tuneOutboundConnections();

// Durable wrapper around the transcription pipeline. The pipeline records
// failure state on the transcript row and rethrows, so Trigger.dev's retry
// policy governs re-runs; claimTranscript() makes retries idempotent.
export const transcribeSourceTask = task({
  id: "transcribe-source",
  // No machine override: the run is two API calls and a JSON write — the
  // provider does the heavy lifting on its own infrastructure. Ingest needs
  // large-2x for ffmpeg; this would waste it.
  run: async (payload: TranscriptionPayload) => {
    await runTranscription(payload);
  },
});
