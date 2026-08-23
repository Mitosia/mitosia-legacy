import { createAssemblyAiProvider } from "./assemblyai";
import { createDeepgramProvider } from "./deepgram";
import { createMockProvider } from "./mock";
import type { TranscriptionProvider } from "./types";

// Provider selection. Like TRIGGER_SECRET_KEY, these are deliberately raw
// process.env reads outside serverEnvSchema: transcription being
// unconfigured must degrade to "sources have no transcript", never abort
// boot — and the Trigger deploy indexes lib/env.ts at import, so a required
// key there becomes a deploy-time constraint for every entrypoint.
//
// Returns the ORDERED list the pipeline tries: Deepgram primary,
// AssemblyAI fallback (tech-stack §6.2) — a provider outage degrades to
// the next adapter instead of a failed transcript. TRANSCRIPTION_PROVIDER
// pins a single provider explicitly: "deepgram", "assemblyai", or "mock"
// (deterministic fake for e2e/dev — see ./mock.ts, never a deployed
// default).

export function getTranscriptionProviders(): TranscriptionProvider[] {
  const explicit = process.env.TRANSCRIPTION_PROVIDER;
  const deepgramKey = process.env.DEEPGRAM_API_KEY;
  const assemblyAiKey = process.env.ASSEMBLYAI_API_KEY;

  if (explicit === "mock") {
    return [createMockProvider()];
  }
  if (explicit === "deepgram") {
    if (!deepgramKey) {
      throw new Error(
        "TRANSCRIPTION_PROVIDER=deepgram requires DEEPGRAM_API_KEY"
      );
    }
    return [createDeepgramProvider(deepgramKey)];
  }
  if (explicit === "assemblyai") {
    if (!assemblyAiKey) {
      throw new Error(
        "TRANSCRIPTION_PROVIDER=assemblyai requires ASSEMBLYAI_API_KEY"
      );
    }
    return [createAssemblyAiProvider(assemblyAiKey)];
  }
  if (explicit !== undefined) {
    throw new Error(`Unknown TRANSCRIPTION_PROVIDER: ${explicit}`);
  }

  const providers: TranscriptionProvider[] = [];
  if (deepgramKey) {
    providers.push(createDeepgramProvider(deepgramKey));
  }
  if (assemblyAiKey) {
    providers.push(createAssemblyAiProvider(assemblyAiKey));
  }
  return providers;
}

export function isTranscriptionConfigured(): boolean {
  return (
    process.env.TRANSCRIPTION_PROVIDER === "mock" ||
    Boolean(process.env.DEEPGRAM_API_KEY) ||
    Boolean(process.env.ASSEMBLYAI_API_KEY)
  );
}
