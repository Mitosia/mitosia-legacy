// Canonical transcript model. This shape is load-bearing beyond S3: the S8
// caption derivation and edit-spec work consume these words, so changes here
// ripple far. Times are integer milliseconds — never float seconds — so
// trim/caption math downstream stays drift-free (see docs/editor-study.md §1).

export interface TranscriptWord {
  // 0-1 as reported by the provider; null when the provider has none
  confidence: number | null;
  endMs: number;
  // Diarization speaker id as a string ("0", "1", …); null when unknown.
  // Display names live in transcript.speaker_labels, never here.
  speaker: string | null;
  startMs: number;
  // Display form (punctuated/formatted when the provider offers it)
  text: string;
}

// Provider-reported speaker-turn boundaries. Hints for segmentation and the
// viewer's paragraph grouping — words remain the source of truth.
export interface TranscriptUtterance {
  endMs: number;
  speaker: string | null;
  startMs: number;
}

// The JSON stored at {sourcePrefix}transcript/rev-N.json. `version` is the
// artifact schema version (bump on shape changes, with a migration path),
// unrelated to the revision number in transcript_revision.
export interface TranscriptData {
  durationMs: number;
  language: string | null;
  utterances: TranscriptUtterance[];
  version: 1;
  words: TranscriptWord[];
}

export interface TranscriptionRequest {
  // Presigned GET URL the provider fetches directly — audio bytes never
  // transit our worker.
  audioUrl: string;
  // Media duration from probe, in seconds. Providers do not need it, but
  // the mock uses it to span realistic timings and the pipeline sanity-
  // checks the result against it.
  durationSeconds: number;
  // Diarization hint for providers that accept one (AssemblyAI's
  // max_speakers_expected): when the caller knows how many voices there
  // are, over-segmentation gets constrained at the source. Unset today —
  // wired up when re-transcription with a hint gets UI.
  maxSpeakers?: number;
  mimeType: string;
}

export interface TranscriptionResult {
  data: TranscriptData;
  model: string;
  provider: string;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe: (request: TranscriptionRequest) => Promise<TranscriptionResult>;
}
