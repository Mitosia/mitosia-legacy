import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { contextSnapshot } from "./analysis";
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

// ---- Extraction (S5, editorial half) ------------------------------------
//
// source_extraction_run is the lifecycle row (one per source, like
// source_analysis); source_extraction holds the extracted material — every
// row anchored to a verbatim transcript span whose range was SNAPPED to
// word boundaries by the grounding aligner (lib/intelligence/grounding.ts).
// Rows that failed grounding are stored with grounded=false for run stats
// but never surfaced by default. Extractions are S6's candidate seeds:
// their ids are stable within a run so candidates can cite them.

const EXTRACTION_KINDS = ["claim", "quote", "story", "qa"] as const;
export type ExtractionKind = (typeof EXTRACTION_KINDS)[number];

// Deterministic, aligner-assigned (verbatim match or not). The model-judged
// values (inference/unsupported) arrive with their S11 consumer — the text
// enum is type-level only, so extending it needs no migration.
const CLAIM_CLASSIFICATIONS = ["direct_quote", "paraphrase"] as const;
export type ClaimClassification = (typeof CLAIM_CLASSIFICATIONS)[number];

export const sourceExtractionRun = pgTable(
  "source_extraction_run",
  {
    attempts: integer("attempts").default(0).notNull(),
    contextSnapshotId: uuid("context_snapshot_id").references(
      () => contextSnapshot.id,
      { onDelete: "set null" }
    ),
    // {kind: {grounded, total}} — the grounding rate is a run-level fact
    counts: jsonb("counts"),
    error: text("error"),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // Which model/provider produced each pass: {"source-extraction.quotes": {...}}
    models: jsonb("models"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Transcript revision extracted from; a current revision above this =
    // stale extractions (surfaced in UI; re-run is a human action)
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
    index("source_extraction_run_org_idx").on(table.organizationId),
    uniqueIndex("source_extraction_run_source_idx").on(table.sourceId),
  ]
);

export const sourceExtraction = pgTable(
  "source_extraction",
  {
    // claims only; null for other kinds
    classification: text("classification", { enum: CLAIM_CLASSIFICATIONS }),
    confidence: real("confidence").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    endMs: integer("end_ms").notNull(),
    grounded: boolean("grounded").notNull(),
    groundingScore: real("grounding_score").notNull(),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    kind: text("kind", { enum: EXTRACTION_KINDS }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Kind-specific extras: {statement?, title?, answerStartMs?}
    payload: jsonb("payload"),
    revision: integer("revision").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => sourceExtractionRun.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    // Majority diarization speaker across the snapped span — derived from
    // the word timeline, never trusted from the model
    speaker: text("speaker"),
    startMs: integer("start_ms").notNull(),
    // Verbatim transcript span, aligner-verified
    text: text("text").notNull(),
  },
  (table) => [
    index("source_extraction_org_idx").on(table.organizationId),
    index("source_extraction_source_idx").on(table.sourceId, table.startMs),
    index("source_extraction_run_idx").on(table.runId),
  ]
);

export const sourceExtractionRunRelations = relations(
  sourceExtractionRun,
  ({ many, one }) => ({
    extractions: many(sourceExtraction),
    source: one(source, {
      fields: [sourceExtractionRun.sourceId],
      references: [source.id],
    }),
  })
);

export const sourceExtractionRelations = relations(
  sourceExtraction,
  ({ one }) => ({
    run: one(sourceExtractionRun, {
      fields: [sourceExtraction.runId],
      references: [sourceExtractionRun.id],
    }),
  })
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
