CREATE TABLE "context_snapshot" (
	"content" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"hash" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"organization_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_analysis" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"context_snapshot_id" uuid,
	"entities" jsonb,
	"error" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"models" jsonb,
	"organization_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"speaker_suggestions" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary" text,
	"topics" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_chapter" (
	"analysis_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"end_ms" integer NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"idx" integer NOT NULL,
	"organization_id" text NOT NULL,
	"start_ms" integer NOT NULL,
	"summary" text,
	"title" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_snapshot" ADD CONSTRAINT "context_snapshot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_analysis" ADD CONSTRAINT "source_analysis_context_snapshot_id_context_snapshot_id_fk" FOREIGN KEY ("context_snapshot_id") REFERENCES "public"."context_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_analysis" ADD CONSTRAINT "source_analysis_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_analysis" ADD CONSTRAINT "source_analysis_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chapter" ADD CONSTRAINT "source_chapter_analysis_id_source_analysis_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."source_analysis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chapter" ADD CONSTRAINT "source_chapter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_snapshot_org_idx" ON "context_snapshot" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "context_snapshot_hash_idx" ON "context_snapshot" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "source_analysis_org_idx" ON "source_analysis" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_analysis_source_idx" ON "source_analysis" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "source_chapter_org_idx" ON "source_chapter" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_chapter_seq_idx" ON "source_chapter" USING btree ("analysis_id","idx");--> statement-breakpoint
ALTER TABLE "context_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "context_snapshot" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "context_snapshot_org_isolation" ON "context_snapshot"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "source_analysis" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_analysis" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "source_analysis_org_isolation" ON "source_analysis"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "source_chapter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_chapter" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "source_chapter_org_isolation" ON "source_chapter"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));
