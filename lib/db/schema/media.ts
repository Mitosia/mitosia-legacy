import { relations, sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
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
import { project } from "./core";

// S2 media ingest tables. All tenant-owned: organization_id + RLS
// (ENABLE + FORCE, policies in the same migration that creates them),
// access only via withOrgScope().

// Lifecycle: uploading → uploaded → processing → ready | failed.
// A failed source can be retried (back to processing).
const SOURCE_STATUSES = [
  "uploading",
  "uploaded",
  "processing",
  "ready",
  "failed",
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

// Pipeline stages, surfaced in the UI while status is "processing".
const INGEST_STEPS = [
  "probe",
  "hls",
  // Distinct from "hls" because it is the second half of the same stage and
  // is not short: the ladder is transcoded, then every playlist and segment
  // is pushed to storage. On the two-hour exit source that upload ran for
  // ~10 minutes while the badge still read "Preparing playback 100%", which
  // is indistinguishable from a hang. The column is plain `text` (no check
  // constraint), so adding a value needs no migration.
  "publish",
  "thumbnails",
  "audio",
  "waveform",
  "finalize",
] as const;
export type IngestStep = (typeof INGEST_STEPS)[number];

const ARTIFACT_KINDS = [
  "hls_master",
  "poster",
  "thumbnail",
  "audio",
  "waveform",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const timestamps = {
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const source = pgTable(
  "source",
  {
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    durationSeconds: doublePrecision("duration_seconds"),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    ingestAttempts: integer("ingest_attempts").default(0).notNull(),
    ingestError: text("ingest_error"),
    // 0–1 through the current step, and only the steps long enough to need
    // it write here (the ladder). Null means "no finer detail than the step
    // name" — a step that takes seconds should not claim a percentage.
    ingestProgress: doublePrecision("ingest_progress"),
    ingestStep: text("ingest_step", { enum: INGEST_STEPS }),
    // ffprobe result: container, video/audio codecs, dimensions, fps, bitrate
    metadata: jsonb("metadata"),
    mimeType: text("mime_type").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    originalFilename: text("original_filename").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    status: text("status", { enum: SOURCE_STATUSES })
      .default("uploading")
      .notNull(),
    // Key of the original object in storage (org/…-prefixed)
    storageKey: text("storage_key").notNull(),
    title: text("title").notNull(),
    // S3 multipart upload id; present only while status = uploading
    uploadId: text("upload_id"),
    ...timestamps,
  },
  (table) => [
    index("source_org_idx").on(table.organizationId),
    index("source_project_idx").on(table.projectId),
    uniqueIndex("source_storage_key_idx").on(table.storageKey),
  ]
);

export const sourceArtifact = pgTable(
  "source_artifact",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    kind: text("kind", { enum: ARTIFACT_KINDS }).notNull(),
    // Per-kind details: thumbnail time offset, image dimensions, peaks config
    metadata: jsonb("metadata"),
    mimeType: text("mime_type").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    ...timestamps,
  },
  (table) => [
    index("source_artifact_org_idx").on(table.organizationId),
    index("source_artifact_source_idx").on(table.sourceId, table.kind),
    uniqueIndex("source_artifact_storage_key_idx").on(table.storageKey),
  ]
);

// Append-only usage metering (thesis: cost visibility is never retrofitted).
// No UPDATE/DELETE policies exist for this table, so the app role cannot
// mutate history even inside its own org — corrections are compensating
// entries. correlation_id makes writers idempotent. No FK on source_id:
// billing history must survive source deletion.
export const usageLedger = pgTable(
  "usage_ledger",
  {
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    entryType: text("entry_type", {
      enum: ["storage_bytes", "processing_minutes"],
    }).notNull(),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    metadata: jsonb("metadata"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    quantity: doublePrecision("quantity").notNull(),
    sourceId: uuid("source_id"),
    unit: text("unit", { enum: ["bytes", "minutes"] }).notNull(),
  },
  (table) => [
    index("usage_ledger_org_idx").on(table.organizationId, table.entryType),
    index("usage_ledger_source_idx").on(table.sourceId),
    uniqueIndex("usage_ledger_correlation_idx").on(table.correlationId),
  ]
);

export const sourceRelations = relations(source, ({ many, one }) => ({
  artifacts: many(sourceArtifact),
  project: one(project, {
    fields: [source.projectId],
    references: [project.id],
  }),
}));

export const sourceArtifactRelations = relations(sourceArtifact, ({ one }) => ({
  source: one(source, {
    fields: [sourceArtifact.sourceId],
    references: [source.id],
  }),
}));
