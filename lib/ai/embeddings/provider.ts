import { createMockEmbeddingProvider } from "./mock";
import type { EmbeddingProvider } from "./types";
import { createVoyageProvider } from "./voyage";

// Provider selection. Raw process.env reads outside serverEnvSchema (the
// TRIGGER_SECRET_KEY precedent): embeddings being unconfigured must degrade
// to "sources have no search index", never abort boot — and the Trigger
// deploy indexes lib/env.ts at import, so a required key there would gate
// every entrypoint. Voyage direct, no gateway (decision 2026-08-24: one
// REST endpoint behind our own seam; the S4 gateway disqualifiers stand).

export function getEmbeddingProvider(): EmbeddingProvider | null {
  const explicit = process.env.EMBEDDING_PROVIDER;
  const voyageKey = process.env.VOYAGE_API_KEY;

  if (explicit === "mock") {
    return createMockEmbeddingProvider();
  }
  if (explicit === "voyage") {
    if (!voyageKey) {
      throw new Error("EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY");
    }
    return createVoyageProvider(voyageKey);
  }
  if (explicit !== undefined) {
    throw new Error(`Unknown EMBEDDING_PROVIDER: ${explicit}`);
  }
  return voyageKey ? createVoyageProvider(voyageKey) : null;
}

export function isEmbeddingConfigured(): boolean {
  return (
    process.env.EMBEDDING_PROVIDER === "mock" ||
    Boolean(process.env.VOYAGE_API_KEY)
  );
}
