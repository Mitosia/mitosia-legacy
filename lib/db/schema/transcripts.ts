import { relations, sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { source } from "./media";

// S3 transcription tables. Tenant-owned: organization_id + RLS (ENABLE +
// FORCE, policies in the same migration that creates them), access only via
// withOrgScope().
//
// The word-level data itself is NOT here: a two-hour source carries 20–30k
// words, so the canonical transcript JSON lives in storage under the org
// prefix ({sourcePrefix}transcript/rev-N.json) and is served through the
// authenticated /api/media proxy like every other media object. These rows
// hold lifecycle, provenance, and the revision ledger. Deliberately not
// source_artifact rows: that table is ingest-owned and claimSource() deletes
// all of it on every re-ingest, which would silently discard paid
// transcriptions.

// Lifecycle: pending → processing → ready | failed. A failed transcript can
// be retried (back to processing). "pending" means enqueued and waiting on a
// worker — the reaper must never touch it (see lib/transcription/reaper.ts).
const TRANSCRIPT_STATUSES = [
  "pending",
  "processing",
  "ready",
  "failed",
] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

const timestamps = {
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const transcript = pgTable(
  "transcript",
  {
    attempts: integer("attempts").default(0).notNull(),
    error: text("error"),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // BCP-47-ish code as reported/detected by the provider ("en", "en-US")
    language: text("language"),
    // Provider model that produced the current revision ("nova-3", …)
    model: text("model"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider"),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    // Diarization speaker id → human name ({"0": "Priya", "1": "Sam"}).
    // A rename is metadata applied at render/export time, never a new
    // revision — revisions are reserved for changes to the words themselves.
    speakerLabels: jsonb("speaker_labels"),
    status: text("status", { enum: TRANSCRIPT_STATUSES })
      .default("pending")
      .notNull(),
    ...timestamps,
  },
  (table) => [
    index("transcript_org_idx").on(table.organizationId),
    uniqueIndex("transcript_source_idx").on(table.sourceId),
  ]
);

// One row per stored transcript JSON. The current revision is the row with
// the highest `revision` — there is deliberately no current_revision_id
// pointer on transcript (it would be a circular FK and a second source of
// truth). created_by is null for machine-produced revisions (the initial
// transcription) and set for human corrections.
export const transcriptRevision = pgTable(
  "transcript_revision",
  {
    createdAt: timestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // Word count, duration span, edit summary — display and sanity checks
    metadata: jsonb("metadata"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    // Required like source_artifact.sizeBytes: the storage ledger entry for
    // a revision is this number, and a missing one under-meters the org.
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcript.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("transcript_revision_org_idx").on(table.organizationId),
    uniqueIndex("transcript_revision_seq_idx").on(
      table.transcriptId,
      table.revision
    ),
    uniqueIndex("transcript_revision_storage_key_idx").on(table.storageKey),
  ]
);

export const transcriptRelations = relations(transcript, ({ many, one }) => ({
  revisions: many(transcriptRevision),
  source: one(source, {
    fields: [transcript.sourceId],
    references: [source.id],
  }),
}));

export const transcriptRevisionRelations = relations(
  transcriptRevision,
  ({ one }) => ({
    transcript: one(transcript, {
      fields: [transcriptRevision.transcriptId],
      references: [transcript.id],
    }),
  })
);
