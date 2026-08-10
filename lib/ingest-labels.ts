import type { IngestStep, SourceStatus } from "@/lib/db/schema";

// User-facing labels for the ingest lifecycle. Keep these plain-language:
// the enum values (hls, probe, …) are internal pipeline vocabulary and must
// never render in the UI.
export const INGEST_STEP_LABELS: Record<IngestStep, string> = {
  audio: "Processing audio",
  finalize: "Almost ready",
  hls: "Preparing playback",
  probe: "Checking recording",
  thumbnails: "Creating previews",
  waveform: "Building waveform",
};

export const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = {
  failed: "Failed",
  processing: "Processing",
  ready: "Ready",
  uploaded: "Queued",
  uploading: "Uploading",
};

export function ingestStepLabel(step: IngestStep | null): string {
  return step ? INGEST_STEP_LABELS[step] : SOURCE_STATUS_LABELS.processing;
}
