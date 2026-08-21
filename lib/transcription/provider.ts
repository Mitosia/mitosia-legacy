import { createDeepgramProvider } from "./deepgram";
import { createMockProvider } from "./mock";
import type { TranscriptionProvider } from "./types";

// Provider selection. Like TRIGGER_SECRET_KEY, these are deliberately raw
// process.env reads outside serverEnvSchema: transcription being
// unconfigured must degrade to "sources have no transcript", never abort
// boot — and the Trigger deploy indexes lib/env.ts at import, so a required
// key there becomes a deploy-time constraint for every entrypoint.
//
// TRANSCRIPTION_PROVIDER: "deepgram" (default when DEEPGRAM_API_KEY is set)
// or "mock" (deterministic fake for e2e/dev — see ./mock.ts). AssemblyAI
// lands as the fallback provider later in S3 behind this same seam.

export function getTranscriptionProvider(): TranscriptionProvider | null {
  const explicit = process.env.TRANSCRIPTION_PROVIDER;
  if (explicit === "mock") {
    return createMockProvider();
  }
  const deepgramKey = process.env.DEEPGRAM_API_KEY;
  if (explicit === "deepgram" || (explicit === undefined && deepgramKey)) {
    if (!deepgramKey) {
      throw new Error(
        "TRANSCRIPTION_PROVIDER=deepgram requires DEEPGRAM_API_KEY"
      );
    }
    return createDeepgramProvider(deepgramKey);
  }
  if (explicit !== undefined) {
    throw new Error(`Unknown TRANSCRIPTION_PROVIDER: ${explicit}`);
  }
  return null;
}

export function isTranscriptionConfigured(): boolean {
  return (
    process.env.TRANSCRIPTION_PROVIDER === "mock" ||
    Boolean(process.env.DEEPGRAM_API_KEY)
  );
}
