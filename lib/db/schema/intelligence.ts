import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { source } from "./media";

// S5 source-intelligence tables (retrieval half). Tenant-owned:
// organization_id + RLS (ENABLE + FORCE, policies in the creating
// migration), access only via withOrgScope().
//
// transcript_chunk holds the embedded retrieval units for semantic search
// and source Q&A: deterministic speaker-turn windows over the transcript
// word timeline (lib/intelligence/chunks.ts), one embedding each. Only the
// CURRENT transcript revision's chunks are kept — an index run replaces the
// set transactionally, and `revision` records which revision they came
// from, which is how staleness is detected after a correction.

// Baked into the vector column and therefore into the migration. voyage-4
// family default; changing it means a new migration + full re-embed, so it
// is a schema fact, not provider config.
export const EMBEDDING_DIMENSIONS = 1024;

const INDEX_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type SourceIndexStatus = (typeof INDEX_STATUSES)[number];

const timestamps = {
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const sourceIndex = pgTable(
  "source_index",
  {
    attempts: integer("attempts").default(0).notNull(),
    // Chunks written by the last successful run — the UI's "indexed" fact
    chunkCount: integer("chunk_count"),
    embeddingModel: text("embedding_model"),
    error: text("error"),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Transcript revision the chunks were built from; null until the first
    // successful run. A current revision above this = stale index.
    revision: integer("revision"),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    status: text("status", { enum: INDEX_STATUSES })
      .default("pending")
      .notNull(),
    ...timestamps,
  },
  (table) => [
    index("source_index_org_idx").on(table.organizationId),
    uniqueIndex("source_index_source_idx").on(table.sourceId),
  ]
);

export const transcriptChunk = pgTable(
  "transcript_chunk",
  {
    createdAt: timestamp("created_at").defaultNow().notNull(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS,
    }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    endMs: integer("end_ms").notNull(),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    idx: integer("idx").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Transcript revision this chunk was cut from (matches source_index)
    revision: integer("revision").notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    // Diarization speaker ids present in the chunk (["0","1"]) — display
    // names resolve through transcript.speaker_labels at render time
    speakers: jsonb("speakers").notNull(),
    startMs: integer("start_ms").notNull(),
    // Display-form text with "Speaker N:" markers at speaker changes —
    // what gets embedded is exactly what gets shown
    text: text("text").notNull(),
    tokenCount: integer("token_count").notNull(),
  },
  (table) => [
    index("transcript_chunk_org_idx").on(table.organizationId),
    uniqueIndex("transcript_chunk_seq_idx").on(table.sourceId, table.idx),
    // Queries always filter by source_id under RLS; per-source sets are a
    // few hundred rows, so this HNSW index is for the org-wide search that
    // arrives later (S12), cheap to carry from day one.
    index("transcript_chunk_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops")
    ),
  ]
);

export const sourceIndexRelations = relations(sourceIndex, ({ one }) => ({
  source: one(source, {
    fields: [sourceIndex.sourceId],
    references: [source.id],
  }),
}));

export const transcriptChunkRelations = relations(
  transcriptChunk,
  ({ one }) => ({
    source: one(source, {
      fields: [transcriptChunk.sourceId],
      references: [source.id],
    }),
  })
);
