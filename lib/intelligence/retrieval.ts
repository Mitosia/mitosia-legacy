import { cosineDistance, desc, eq, sql } from "drizzle-orm";
import { getEmbeddingProvider } from "@/lib/ai/embeddings/provider";
import { transcriptChunk } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";

// Within-source semantic retrieval (S5): embed the query, rank the
// source's chunks by cosine similarity under RLS. Per-source chunk sets
// are a few hundred rows, so exactness is not a concern at this scale; the
// HNSW index earns its keep when search goes org-wide (S12).

export interface RetrievedChunk {
  endMs: number;
  id: string;
  idx: number;
  score: number;
  speakers: string[];
  startMs: number;
  text: string;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  embedModel: string;
  embedTokens: number;
}

export async function searchSourceChunks(
  organizationId: string,
  sourceId: string,
  query: string,
  limit: number
): Promise<RetrievalResult> {
  const provider = getEmbeddingProvider();
  if (!provider) {
    throw new Error(
      "No embedding provider configured (set VOYAGE_API_KEY or EMBEDDING_PROVIDER)"
    );
  }
  const embedded = await provider.embed([query], "query");
  const [vector] = embedded.vectors;
  if (!vector) {
    throw new Error("Query embedding came back empty");
  }

  const distance = cosineDistance(transcriptChunk.embedding, vector);
  const rows = await withOrgScope(organizationId, (tx) =>
    tx
      .select({
        endMs: transcriptChunk.endMs,
        id: transcriptChunk.id,
        idx: transcriptChunk.idx,
        similarity: sql<number>`1 - (${distance})`,
        speakers: transcriptChunk.speakers,
        startMs: transcriptChunk.startMs,
        text: transcriptChunk.text,
      })
      .from(transcriptChunk)
      .where(eq(transcriptChunk.sourceId, sourceId))
      .orderBy(desc(sql`1 - (${distance})`))
      .limit(limit)
  );

  return {
    chunks: rows.map((row) => ({
      endMs: row.endMs,
      id: row.id,
      idx: row.idx,
      score: Number(row.similarity),
      speakers: (row.speakers as string[] | null) ?? [],
      startMs: row.startMs,
      text: row.text,
    })),
    embedModel: embedded.model,
    embedTokens: embedded.tokens,
  };
}
