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
import { organization, user } from "./auth";
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

// ---- Moment discovery (S6) -----------------------------------------------
//
// moment_discovery_run is the lifecycle row (one per source, the
// source_extraction_run clone); moment_candidate holds the clip-worthy
// moments the discovery pass proposed — every candidate anchored to a
// verbatim transcript phrase the grounding aligner verified inside its
// SNAPPED (sentence-aligned) range. Ungrounded rows persist with
// grounded=false for run stats but never surface. Candidate ids are stable
// within a run — S8 edit specs will reference them — but re-runs
// delete-and-replace, which is why the rerun action refuses when human
// decisions exist (the decisions ARE the M1 record).

// Human review verdicts (D5): first-class columns, never client state —
// acceptance rate and boundary-adjustment magnitude are each one SQL query.
const CANDIDATE_STATUSES = [
  "proposed",
  "shortlisted",
  "accepted",
  "rejected",
] as const;
export type MomentCandidateStatus = (typeof CANDIDATE_STATUSES)[number];

// Reviewer-agent fix vocabulary (S6 §9): constrained on purpose — an
// unconstrained critic suggests operations the editor can't perform
// (the EditDuet lesson, docs/clipping-landscape.md). Type-level only.
const REVIEW_FIXES = [
  "none",
  "extend_start",
  "trim_end",
  "retitle",
  "drop",
] as const;
export type MomentReviewFix = (typeof REVIEW_FIXES)[number];

// TypeScript-level enum only (no DB constraint) — extends without migration.
const REJECT_REASONS = [
  "not_interesting",
  "wrong_boundaries",
  "out_of_context",
  "sensitive",
  "duplicate",
  "other",
] as const;
export type MomentRejectReason = (typeof REJECT_REASONS)[number];

export const momentDiscoveryRun = pgTable(
  "moment_discovery_run",
  {
    attempts: integer("attempts").default(0).notNull(),
    contextSnapshotId: uuid("context_snapshot_id").references(
      () => contextSnapshot.id,
      { onDelete: "set null" }
    ),
    // {proposed, grounded, suppressed} — run-level facts for stats/UI
    counts: jsonb("counts"),
    error: text("error"),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // {"moment-discovery.candidates": {model, provider}}
    models: jsonb("models"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Transcript revision discovered from; a newer current revision =
    // stale candidates (re-run is a human action, like extraction)
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
    index("moment_discovery_run_org_idx").on(table.organizationId),
    uniqueIndex("moment_discovery_run_source_idx").on(table.sourceId),
  ]
);

export const momentCandidate = pgTable(
  "moment_candidate",
  {
    // Human boundary edits; null until touched. |adjusted − snapped| is
    // the M1 boundary-adjustment metric.
    adjustedEndMs: integer("adjusted_end_ms"),
    adjustedStartMs: integer("adjusted_start_ms"),
    // Verbatim phrase from inside the moment, aligner-verified
    anchorText: text("anchor_text").notNull(),
    // See MOMENT_COMPOSITE_WEIGHTS (lib/intelligence/moments.ts) — risk is
    // deliberately excluded (a flag, not a demerit)
    composite: real("composite").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    decidedAt: timestamp("decided_at"),
    decidedBy: text("decided_by").references(() => user.id, {
      onDelete: "set null",
    }),
    // Shared by the kept candidate and its suppressed duplicates; null for
    // candidates that never collided
    dedupeGroup: integer("dedupe_group"),
    endMs: integer("end_ms").notNull(),
    grounded: boolean("grounded").notNull(),
    groundingScore: real("grounding_score").notNull(),
    // One sentence: why a viewer stops scrolling
    hook: text("hook").notNull(),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // 0-based after dedupe+sort; display order (survivors first)
    rank: integer("rank").notNull(),
    // Model's original claim, pre-snap — instrumentation for how far
    // snapping moved the boundaries
    rawEndMs: integer("raw_end_ms").notNull(),
    rawStartMs: integer("raw_start_ms").notNull(),
    rejectNote: text("reject_note"),
    rejectReason: text("reject_reason", { enum: REJECT_REASONS }),
    // Cold-context reviewer verdict (S6 §9): the agent saw ONLY this
    // clip's own span + title, never the episode. Null = not reviewed
    // (reviewer off, or the pass failed — it never fails discovery).
    reviewFix: text("review_fix", { enum: REVIEW_FIXES }),
    reviewNotes: text("review_notes"),
    // {opensCold, resolves, standsAlone, titleTruthful} each 0|1|2 —
    // coarse on purpose (finer scales judge inconsistently; dossier §3)
    reviewScores: jsonb("review_scores"),
    revision: integer("revision").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => momentDiscoveryRun.id, { onDelete: "cascade" }),
    // {comprehensibility, hook, insight, relevance, risk} each 0–1
    scores: jsonb("scores").notNull(),
    // source_extraction ids the model says it drew on (may be empty)
    seedIds: jsonb("seed_ids").notNull(),
    // risk ≥ 0.6 → badge in the UI, never auto-exclusion
    sensitive: boolean("sensitive").notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    // SNAPPED (sentence-aligned) bounds — what plays
    startMs: integer("start_ms").notNull(),
    status: text("status", { enum: CANDIDATE_STATUSES })
      .default("proposed")
      .notNull(),
    summary: text("summary").notNull(),
    // Lost its dedupe group; kept for instrumentation, hidden by default
    suppressed: boolean("suppressed").notNull(),
    title: text("title").notNull(),
  },
  (table) => [
    index("moment_candidate_org_idx").on(table.organizationId),
    index("moment_candidate_source_idx").on(table.sourceId, table.rank),
    index("moment_candidate_run_idx").on(table.runId),
  ]
);

export const momentDiscoveryRunRelations = relations(
  momentDiscoveryRun,
  ({ many, one }) => ({
    candidates: many(momentCandidate),
    source: one(source, {
      fields: [momentDiscoveryRun.sourceId],
      references: [source.id],
    }),
  })
);

export const momentCandidateRelations = relations(
  momentCandidate,
  ({ one }) => ({
    run: one(momentDiscoveryRun, {
      fields: [momentCandidate.runId],
      references: [momentDiscoveryRun.id],
    }),
  })
);

// ---- Segment clips (S6.5, the coverage lane) ------------------------------
//
// segment_plan_run is the lifecycle row (one per source, the discovery-run
// clone); segment_clip holds the episode PARTITION the Editor pass
// proposed: chronological keep/drop rows that tile the whole recording —
// every second accounted for (docs/episode-to-clips.md §4, coverage
// invariant). Keeps are chapters-as-videos whose anchor grounded inside
// their span; drops carry a reason and are restorable. No numeric
// length/count constraints anywhere (constraint policy, 2026-08-26):
// duration/count outliers become observability flags for the human
// reviewer, never auto-enforcement.

const SEGMENT_KINDS = ["keep", "drop"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

const SEGMENT_STATUSES = ["proposed", "accepted", "rejected"] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

// Type-level only — extends without migration.
const DROP_REASONS = [
  "housekeeping",
  "sponsor",
  "low_energy",
  "weaker_telling",
  "thin",
  "other",
] as const;
export type SegmentDropReason = (typeof DROP_REASONS)[number];

export const segmentPlanRun = pgTable(
  "segment_plan_run",
  {
    attempts: integer("attempts").default(0).notNull(),
    contextSnapshotId: uuid("context_snapshot_id").references(
      () => contextSnapshot.id,
      { onDelete: "set null" }
    ),
    // {segments, kept, dropped, grounded, flagged, reviewed} — run facts
    counts: jsonb("counts"),
    error: text("error"),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    models: jsonb("models"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
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
    index("segment_plan_run_org_idx").on(table.organizationId),
    uniqueIndex("segment_plan_run_source_idx").on(table.sourceId),
  ]
);

export const segmentClip = pgTable(
  "segment_clip",
  {
    // Human boundary edits; null until touched
    adjustedEndMs: integer("adjusted_end_ms"),
    adjustedStartMs: integer("adjusted_start_ms"),
    // Verbatim phrase from inside the segment, aligner-verified; null on
    // drops (nothing to ground)
    anchorText: text("anchor_text"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    decidedAt: timestamp("decided_at"),
    decidedBy: text("decided_by").references(() => user.id, {
      onDelete: "set null",
    }),
    // drop rows only: why this stretch earns no clip
    dropReason: text("drop_reason", { enum: DROP_REASONS }),
    endMs: integer("end_ms").notNull(),
    // Observability flags (constraint policy): ["short_outlier",
    // "long_outlier", "twice_told", "gap_fill", …] — reviewer-facing,
    // never enforcement
    flags: jsonb("flags").notNull(),
    grounded: boolean("grounded").notNull(),
    groundingScore: real("grounding_score").notNull(),
    hook: text("hook"),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // Chronological position in the plan (0-based) — segments are a
    // timeline partition, not a ranking
    idx: integer("idx").notNull(),
    kind: text("kind", { enum: SEGMENT_KINDS }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    rawEndMs: integer("raw_end_ms").notNull(),
    rawStartMs: integer("raw_start_ms").notNull(),
    rejectNote: text("reject_note"),
    rejectReason: text("reject_reason", { enum: REJECT_REASONS }),
    // Cold-context reviewer verdict on keeps (same agent as moments)
    reviewFix: text("review_fix", { enum: REVIEW_FIXES }),
    reviewNotes: text("review_notes"),
    reviewScores: jsonb("review_scores"),
    revision: integer("revision").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => segmentPlanRun.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    startMs: integer("start_ms").notNull(),
    status: text("status", { enum: SEGMENT_STATUSES })
      .default("proposed")
      .notNull(),
    summary: text("summary"),
    title: text("title"),
  },
  (table) => [
    index("segment_clip_org_idx").on(table.organizationId),
    index("segment_clip_source_idx").on(table.sourceId, table.idx),
    index("segment_clip_run_idx").on(table.runId),
  ]
);

export const segmentPlanRunRelations = relations(
  segmentPlanRun,
  ({ many, one }) => ({
    segments: many(segmentClip),
    source: one(source, {
      fields: [segmentPlanRun.sourceId],
      references: [source.id],
    }),
  })
);

export const segmentClipRelations = relations(segmentClip, ({ one }) => ({
  run: one(segmentPlanRun, {
    fields: [segmentClip.runId],
    references: [segmentPlanRun.id],
  }),
}));

// ---- Source Q&A (S5) -----------------------------------------------------
//
// One row per question asked of a source: the answer, its verified
// citations, and usage — history UX, the ledger correlation, and a growing
// pool of real eval cases. Citations are [{startMs, endMs, quote}] and are
// deterministically clamped to retrieved-chunk ranges before persisting —
// the model cannot cite what retrieval didn't show it.

export const sourceQuestion = pgTable(
  "source_question",
  {
    answer: text("answer"),
    // false = the model said the source doesn't cover it (an honest miss,
    // rendered as such — never an empty answer)
    answerable: boolean("answerable"),
    citations: jsonb("citations"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    error: text("error"),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // {model, provider, inputTokens, outputTokens, embedTokens, costUsd}
    metadata: jsonb("metadata"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["ready", "failed"] }).notNull(),
  },
  (table) => [
    index("source_question_org_idx").on(table.organizationId),
    index("source_question_source_idx").on(table.sourceId, table.createdAt),
  ]
);

export const sourceQuestionRelations = relations(sourceQuestion, ({ one }) => ({
  source: one(source, {
    fields: [sourceQuestion.sourceId],
    references: [source.id],
  }),
}));

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
