import { z } from "zod";
import type {
  TranscriptData,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
  TranscriptUtterance,
  TranscriptWord,
} from "./types";

// AssemblyAI adapter (fallback provider). Same discipline as the Deepgram
// adapter: the SDK does transport and its internal submit+poll loop, our
// own zod schema parses the result — a shape change is a loud provider-
// contract alarm, not silently dropped speakers.
//
// Two provider quirks normalized here so the canonical model stays
// provider-agnostic: times are already integer milliseconds (no conversion,
// unlike Deepgram's float seconds), and speakers are letters ("A", "B")
// which become the canonical numeric strings ("0", "1").

const ASSEMBLYAI_MODEL = "universal";

const wordSchema = z.object({
  confidence: z.number(),
  end: z.number(),
  speaker: z.string().nullable(),
  start: z.number(),
  text: z.string(),
});

const utteranceSchema = z.object({
  end: z.number(),
  speaker: z.string().nullable(),
  start: z.number(),
});

const transcriptSchema = z.object({
  audio_duration: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  language_code: z.string().nullable().optional(),
  status: z.string(),
  utterances: z.array(utteranceSchema).nullable().optional(),
  words: z.array(wordSchema).nullable().optional(),
});

const LETTER_SPEAKER = /^[A-Z]$/;

function normalizeSpeaker(speaker: string | null): string | null {
  if (speaker === null) {
    return null;
  }
  // "A" → "0", "B" → "1": one canonical id space across providers, so
  // speaker_labels, colors, and "Speaker N" fallbacks behave identically
  // whichever provider transcribed the source.
  if (LETTER_SPEAKER.test(speaker)) {
    return String(speaker.charCodeAt(0) - 65);
  }
  return speaker;
}

// Exported for the golden tests: fixture responses go through the exact
// mapping production uses.
export function normalizeAssemblyAiTranscript(
  raw: unknown,
  fallbackDurationSeconds: number
): TranscriptData {
  const parsed = transcriptSchema.parse(raw);
  if (parsed.status === "error") {
    throw new Error(`AssemblyAI transcription failed: ${parsed.error}`);
  }

  const words: TranscriptWord[] = (parsed.words ?? []).map((word) => ({
    confidence: word.confidence,
    endMs: Math.round(word.end),
    speaker: normalizeSpeaker(word.speaker),
    startMs: Math.round(word.start),
    text: word.text,
  }));

  const utterances: TranscriptUtterance[] = (parsed.utterances ?? []).map(
    (utterance) => ({
      endMs: Math.round(utterance.end),
      speaker: normalizeSpeaker(utterance.speaker),
      startMs: Math.round(utterance.start),
    })
  );

  return {
    durationMs: Math.round(
      (parsed.audio_duration ?? fallbackDurationSeconds) * 1000
    ),
    language: parsed.language_code ?? null,
    utterances,
    version: 1,
    words,
  };
}

export function createAssemblyAiProvider(
  apiKey: string
): TranscriptionProvider {
  return {
    name: "assemblyai",
    async transcribe(
      request: TranscriptionRequest
    ): Promise<TranscriptionResult> {
      const { AssemblyAI } = await import("assemblyai");
      const client = new AssemblyAI({ apiKey });
      // transcribe() = submit + poll until terminal; the Trigger task is
      // the right place for that blocking wait.
      const result = await client.transcripts.transcribe({
        audio: request.audioUrl,
        language_detection: true,
        speaker_labels: true,
        // The over-segmentation lever Deepgram lacks: when the caller
        // knows how many voices there are, say so.
        speaker_options: request.maxSpeakers
          ? { max_speakers_expected: request.maxSpeakers }
          : undefined,
        speech_model: ASSEMBLYAI_MODEL,
      });
      return {
        data: normalizeAssemblyAiTranscript(result, request.durationSeconds),
        model: ASSEMBLYAI_MODEL,
        provider: "assemblyai",
      };
    },
  };
}
