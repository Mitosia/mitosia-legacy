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
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { source } from "./media";

// S4 source-analysis tables. Tenant-owned: organization_id + RLS (ENABLE +
// FORCE, policies in the creating migration), access only via withOrgScope().
//
// Chapters are ROWS (the source map UI seeks by them and S8 consumes them);
// summary/topics/entities/speaker suggestions live on the analysis row as
// jsonb — they are read whole, never queried into. Every analysis records
// the context snapshot it ran with (thesis §11 provenance): the snapshot is
// the assembled pack stored verbatim, so "what did the model know" is
// always answerable.

const ANALYSIS_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

const timestamps = {
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const contextSnapshot = pgTable(
  "context_snapshot",
  {
    // The assembled pack, verbatim
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // sha256 of the canonical serialization — dedupe and drift detection
    hash: text("hash").notNull(),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // What the pack was assembled for ("source-analysis", later capabilities)
    kind: text("kind").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("context_snapshot_org_idx").on(table.organizationId),
    index("context_snapshot_hash_idx").on(table.hash),
  ]
);

export const sourceAnalysis = pgTable(
  "source_analysis",
  {
    attempts: integer("attempts").default(0).notNull(),
    contextSnapshotId: uuid("context_snapshot_id").references(
      () => contextSnapshot.id,
      { onDelete: "set null" }
    ),
    // [{name, type}] — entity inventory for chips and S5 extraction seeds
    entities: jsonb("entities"),
    error: text("error"),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // Which model/provider produced each part: {chapters: {...}, editorial: {...}}
    models: jsonb("models"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    // [{speaker, suggestedName, confidence, evidence, mergeWith}] — rendered
    // as confirmed suggestions; Apply drives the speaker_labels action
    speakerSuggestions: jsonb("speaker_suggestions"),
    status: text("status", { enum: ANALYSIS_STATUSES })
      .default("pending")
      .notNull(),
    summary: text("summary"),
    // string[] — topic chips
    topics: jsonb("topics"),
    ...timestamps,
  },
  (table) => [
    index("source_analysis_org_idx").on(table.organizationId),
    uniqueIndex("source_analysis_source_idx").on(table.sourceId),
  ]
);

export const sourceChapter = pgTable(
  "source_chapter",
  {
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => sourceAnalysis.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    endMs: integer("end_ms").notNull(),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    idx: integer("idx").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    startMs: integer("start_ms").notNull(),
    summary: text("summary"),
    title: text("title").notNull(),
  },
  (table) => [
    index("source_chapter_org_idx").on(table.organizationId),
    uniqueIndex("source_chapter_seq_idx").on(table.analysisId, table.idx),
  ]
);

export const sourceAnalysisRelations = relations(
  sourceAnalysis,
  ({ many, one }) => ({
    chapters: many(sourceChapter),
    contextSnapshot: one(contextSnapshot, {
      fields: [sourceAnalysis.contextSnapshotId],
      references: [contextSnapshot.id],
    }),
    source: one(source, {
      fields: [sourceAnalysis.sourceId],
      references: [source.id],
    }),
  })
);

export const sourceChapterRelations = relations(sourceChapter, ({ one }) => ({
  analysis: one(sourceAnalysis, {
    fields: [sourceChapter.analysisId],
    references: [sourceAnalysis.id],
  }),
}));
