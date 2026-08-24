import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSIONS } from "@/lib/db/schema/intelligence";
import type { EmbeddingProvider } from "./types";

// Deterministic fake embedder for e2e and local development, selected via
// EMBEDDING_PROVIDER=mock — never a deployed default. Hashed bag-of-words
// vectors: each token lands in a stable dimension bucket, so texts sharing
// words are cosine-similar and a query containing a chunk's words ranks
// that chunk first. No semantics, full determinism — exactly what a CI
// retrieval assertion needs.

export const MOCK_EMBEDDING_MODEL = "mock-embed-1";

const NON_WORD = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE = /\s+/;

// Stable across runs and platforms: first 4 bytes of the token's sha256.
function hashToken(token: string): number {
  return createHash("sha256").update(token).digest().readUInt32BE(0);
}

export function tokenizeForMock(text: string): string[] {
  return text
    .toLowerCase()
    .replace(NON_WORD, " ")
    .split(WHITESPACE)
    .filter((token) => token.length > 0);
}

export function mockEmbedText(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const token of tokenizeForMock(text)) {
    vector[hashToken(token) % EMBEDDING_DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

export function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    embed(texts) {
      let tokens = 0;
      const vectors = texts.map((text) => {
        tokens += tokenizeForMock(text).length;
        return mockEmbedText(text);
      });
      return Promise.resolve({
        model: MOCK_EMBEDDING_MODEL,
        tokens,
        vectors,
      });
    },
    name: "mock",
  };
}
