import type {
  TranscriptData,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
  TranscriptUtterance,
  TranscriptWord,
} from "./types";

// Deterministic fake provider for e2e and local development. The CI fixture
// is a sine wave with no speech, so real providers can prove nothing there;
// this exercises the full lifecycle (enqueue → processing → ready → storage
// JSON → ledger → UI) with stable output. Selected via
// TRANSCRIPTION_PROVIDER=mock — never a default in deployed environments.

// Two speakers, sentence-alternating; one deliberately low-confidence word
// per sentence so low-confidence UI has something to highlight.
const SCRIPT: { confidence?: number; text: string }[][] = [
  [
    { text: "Welcome" },
    { text: "to" },
    { text: "the" },
    { confidence: 0.42, text: "Mitosia" },
    { text: "mock" },
    { text: "transcript." },
  ],
  [
    { text: "Every" },
    { text: "word" },
    { text: "here" },
    { text: "carries" },
    { confidence: 0.55, text: "timestamps," },
    { text: "confidence," },
    { text: "and" },
    { text: "a" },
    { text: "speaker." },
  ],
  [
    { text: "Sources" },
    { text: "of" },
    { text: "any" },
    { confidence: 0.48, text: "duration" },
    { text: "get" },
    { text: "words" },
    { text: "spanning" },
    { text: "their" },
    { text: "full" },
    { text: "length." },
  ],
];

export function createMockProvider(): TranscriptionProvider {
  return {
    name: "mock",
    transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
      const durationMs = Math.round(request.durationSeconds * 1000);
      const totalWords = SCRIPT.reduce(
        (count, sentence) => count + sentence.length,
        0
      );
      // Words spread evenly across the whole media duration, so downstream
      // duration sanity checks see realistic coverage. 80% speech / 20% gap
      // per slot keeps word boundaries distinct.
      const slotMs = durationMs / totalWords;

      const words: TranscriptWord[] = [];
      const utterances: TranscriptUtterance[] = [];
      let index = 0;
      for (const [sentenceIndex, sentence] of SCRIPT.entries()) {
        const speaker = String(sentenceIndex % 2);
        const sentenceStart = Math.round(index * slotMs);
        for (const word of sentence) {
          const startMs = Math.round(index * slotMs);
          words.push({
            confidence: word.confidence ?? 0.97,
            endMs: Math.round(startMs + slotMs * 0.8),
            speaker,
            startMs,
            text: word.text,
          });
          index += 1;
        }
        utterances.push({
          endMs: words.at(-1)?.endMs ?? sentenceStart,
          speaker,
          startMs: sentenceStart,
        });
      }

      const data: TranscriptData = {
        durationMs,
        language: "en",
        utterances,
        version: 1,
        words,
      };
      return Promise.resolve({ data, model: "mock-1", provider: "mock" });
    },
  };
}
