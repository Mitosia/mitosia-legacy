import { transcript } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import type { TranscriptionPayload } from "./pipeline";
import { isTranscriptionConfigured } from "./provider";

// Single seam for kicking off transcription, mirroring enqueueIngest. Called
// from the ingest pipeline after finalize (so it runs in the Trigger worker
// or the dev in-process fallback — never in a request scope, hence no
// `after()` here) and from the retry action.
//
// Unconfigured environments get no transcript row at all: absence is the
// "not configured" signal, and nothing sits at "pending" forever.
export async function enqueueTranscription(
  payload: TranscriptionPayload
): Promise<void> {
  if (!isTranscriptionConfigured()) {
    return;
  }

  // The pending row exists before the job does, so the UI can show "queued"
  // and the claim step has something to claim. Idempotent via the unique
  // source_id index.
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .insert(transcript)
      .values({
        organizationId: payload.organizationId,
        sourceId: payload.sourceId,
        status: "pending",
      })
      .onConflictDoNothing({ target: transcript.sourceId })
  );

  if (process.env.TRIGGER_SECRET_KEY) {
    const { tasks } = await import("@trigger.dev/sdk");
    const { transcribeSourceTask } = await import(
      "@/trigger/transcribe-source"
    );
    await tasks.trigger<typeof transcribeSourceTask>(
      "transcribe-source",
      payload,
      {
        // Per-org fairness, same as ingest
        concurrencyKey: payload.organizationId,
      }
    );
    return;
  }

  // Dev fallback: fire-and-forget in-process. Deliberately not `after()` —
  // this runs from the pipeline (Trigger worker or an existing after()
  // callback), never a request scope. Same documented limitation as the
  // ingest fallback: it dies with the dev server, and the claim step plus
  // the reaper make that survivable.
  const runInProcess = async () => {
    const { runTranscription } = await import("./pipeline");
    await runTranscription(payload);
  };
  runInProcess().catch((error) => {
    console.error(`[transcription] source ${payload.sourceId} failed:`, error);
  });
}
