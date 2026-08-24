-- pgvector: required by transcript_chunk.embedding. Available on Neon and
-- in the pgvector/pgvector:pg18 image (docker-compose.yml + ci.yml).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "source_index" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer,
	"embedding_model" text,
	"error" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"revision" integer,
	"source_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_chunk" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedding_model" text NOT NULL,
	"end_ms" integer NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"idx" integer NOT NULL,
	"organization_id" text NOT NULL,
	"revision" integer NOT NULL,
	"source_id" uuid NOT NULL,
	"speakers" jsonb NOT NULL,
	"start_ms" integer NOT NULL,
	"text" text NOT NULL,
	"token_count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_index" ADD CONSTRAINT "source_index_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_index" ADD CONSTRAINT "source_index_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_chunk" ADD CONSTRAINT "transcript_chunk_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_chunk" ADD CONSTRAINT "transcript_chunk_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_index_org_idx" ON "source_index" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_index_source_idx" ON "source_index" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "transcript_chunk_org_idx" ON "transcript_chunk" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_chunk_seq_idx" ON "transcript_chunk" USING btree ("source_id","idx");--> statement-breakpoint
CREATE INDEX "transcript_chunk_embedding_idx" ON "transcript_chunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
ALTER TABLE "source_index" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_index" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "source_index_org_isolation" ON "source_index"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "transcript_chunk" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transcript_chunk" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "transcript_chunk_org_isolation" ON "transcript_chunk"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));