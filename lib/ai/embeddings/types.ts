// Embedding provider seam (S5), mirroring TranscriptionProvider: adapters
// wrap the provider API, the pipeline consumes the interface, and a
// deterministic mock stands in for e2e/dev. Deliberately a SINGLE provider
// rather than an ordered failover list — embedding spaces are not
// interchangeable, so "degrade to the next embedder" would write vectors
// incomparable with every one already stored.

// Voyage distinguishes retrieval documents from retrieval queries; other
// providers ignore the hint.
export type EmbeddingInputType = "document" | "query";

export interface EmbeddingResult {
  // Model id as reported by the provider — recorded on every chunk row
  model: string;
  // Provider-reported input tokens, metered to the usage ledger
  tokens: number;
  // One vector per input text, in input order
  vectors: number[][];
}

export interface EmbeddingProvider {
  embed: (
    texts: string[],
    inputType: EmbeddingInputType
  ) => Promise<EmbeddingResult>;
  readonly name: string;
}
