import { z } from "zod";
import type {
  TranscriptData,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
  TranscriptUtterance,
  TranscriptWord,
} from "./types";

// Deepgram adapter (primary provider). Uses @deepgram/sdk v5 for transport
// and auth but parses the raw response with our own schema: the SDK's
// generated types omit the diarization fields (`speaker`,
// `punctuated_word`) that are the entire point of this integration, and an
// explicit parse fails loudly on a provider contract change instead of
// silently dropping speakers.

const DEEPGRAM_MODEL = "nova-3";

const wordSchema = z.object({
  confidence: z.number().optional(),
  end: z.number(),
  punctuated_word: z.string().optional(),
  speaker: z.number().optional(),
  start: z.number(),
  word: z.string(),
});

const utteranceSchema = z.object({
  end: z.number(),
  speaker: z.number().optional(),
  start: z.number(),
});

const responseSchema = z.object({
  metadata: z.object({ duration: z.number().optional() }).optional(),
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z.array(
            z.object({ words: z.array(wordSchema).default([]) })
          ),
          detected_language: z.string().optional(),
        })
      )
      .min(1),
    utterances: z.array(utteranceSchema).optional(),
  }),
});

export function toMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

// Exported for the golden tests: fixture responses go through the exact
// mapping production uses.
export function normalizeDeepgramResponse(
  raw: unknown,
  fallbackDurationSeconds: number
): TranscriptData {
  const parsed = responseSchema.parse(raw);
  const [channel] = parsed.results.channels;
  const [alternative] = channel?.alternatives ?? [];

  const words: TranscriptWord[] = (alternative?.words ?? []).map((word) => ({
    confidence: word.confidence ?? null,
    endMs: toMs(word.end),
    speaker: word.speaker === undefined ? null : String(word.speaker),
    startMs: toMs(word.start),
    text: word.punctuated_word ?? word.word,
  }));

  const utterances: TranscriptUtterance[] = (
    parsed.results.utterances ?? []
  ).map((utterance) => ({
    endMs: toMs(utterance.end),
    speaker: utterance.speaker === undefined ? null : String(utterance.speaker),
    startMs: toMs(utterance.start),
  }));

  return {
    durationMs: toMs(parsed.metadata?.duration ?? fallbackDurationSeconds),
    language: channel?.detected_language ?? null,
    utterances,
    version: 1,
    words,
  };
}

export function createDeepgramProvider(apiKey: string): TranscriptionProvider {
  return {
    name: "deepgram",
    async transcribe(
      request: TranscriptionRequest
    ): Promise<TranscriptionResult> {
      const { DeepgramClient } = await import("@deepgram/sdk");
      const client = new DeepgramClient({ apiKey });
      const response = await client.listen.v1.media.transcribeUrl({
        detect_language: true,
        diarize: true,
        model: DEEPGRAM_MODEL,
        punctuate: true,
        smart_format: true,
        url: request.audioUrl,
        utterances: true,
      });
      return {
        data: normalizeDeepgramResponse(response, request.durationSeconds),
        model: DEEPGRAM_MODEL,
        provider: "deepgram",
      };
    },
  };
}
