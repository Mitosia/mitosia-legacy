CREATE TABLE "segment_clip" (
	"adjusted_end_ms" integer,
	"adjusted_start_ms" integer,
	"anchor_text" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"decided_by" text,
	"drop_reason" text,
	"end_ms" integer NOT NULL,
	"flags" jsonb NOT NULL,
	"grounded" boolean NOT NULL,
	"grounding_score" real NOT NULL,
	"hook" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"idx" integer NOT NULL,
	"kind" text NOT NULL,
	"organization_id" text NOT NULL,
	"raw_end_ms" integer NOT NULL,
	"raw_start_ms" integer NOT NULL,
	"reject_note" text,
	"reject_reason" text,
	"review_fix" text,
	"review_notes" text,
	"review_scores" jsonb,
	"revision" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"start_ms" integer NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"summary" text,
	"title" text
);
--> statement-breakpoint
CREATE TABLE "segment_plan_run" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"context_snapshot_id" uuid,
	"counts" jsonb,
	"error" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"models" jsonb,
	"organization_id" text NOT NULL,
	"revision" integer,
	"source_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "segment_clip" ADD CONSTRAINT "segment_clip_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_clip" ADD CONSTRAINT "segment_clip_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_clip" ADD CONSTRAINT "segment_clip_run_id_segment_plan_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."segment_plan_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_clip" ADD CONSTRAINT "segment_clip_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_plan_run" ADD CONSTRAINT "segment_plan_run_context_snapshot_id_context_snapshot_id_fk" FOREIGN KEY ("context_snapshot_id") REFERENCES "public"."context_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_plan_run" ADD CONSTRAINT "segment_plan_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_plan_run" ADD CONSTRAINT "segment_plan_run_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "segment_clip_org_idx" ON "segment_clip" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "segment_clip_source_idx" ON "segment_clip" USING btree ("source_id","idx");--> statement-breakpoint
CREATE INDEX "segment_clip_run_idx" ON "segment_clip" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "segment_plan_run_org_idx" ON "segment_plan_run" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "segment_plan_run_source_idx" ON "segment_plan_run" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "segment_plan_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "segment_plan_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "segment_plan_run_org_isolation" ON "segment_plan_run"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "segment_clip" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "segment_clip" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "segment_clip_org_isolation" ON "segment_clip"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));
