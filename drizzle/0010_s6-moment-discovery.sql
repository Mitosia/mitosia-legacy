CREATE TABLE "moment_candidate" (
	"adjusted_end_ms" integer,
	"adjusted_start_ms" integer,
	"anchor_text" text NOT NULL,
	"composite" real NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"decided_by" text,
	"dedupe_group" integer,
	"end_ms" integer NOT NULL,
	"grounded" boolean NOT NULL,
	"grounding_score" real NOT NULL,
	"hook" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"rank" integer NOT NULL,
	"raw_end_ms" integer NOT NULL,
	"raw_start_ms" integer NOT NULL,
	"reject_note" text,
	"reject_reason" text,
	"revision" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"scores" jsonb NOT NULL,
	"seed_ids" jsonb NOT NULL,
	"sensitive" boolean NOT NULL,
	"source_id" uuid NOT NULL,
	"start_ms" integer NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"summary" text NOT NULL,
	"suppressed" boolean NOT NULL,
	"title" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moment_discovery_run" (
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
ALTER TABLE "moment_candidate" ADD CONSTRAINT "moment_candidate_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_candidate" ADD CONSTRAINT "moment_candidate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_candidate" ADD CONSTRAINT "moment_candidate_run_id_moment_discovery_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."moment_discovery_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_candidate" ADD CONSTRAINT "moment_candidate_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_discovery_run" ADD CONSTRAINT "moment_discovery_run_context_snapshot_id_context_snapshot_id_fk" FOREIGN KEY ("context_snapshot_id") REFERENCES "public"."context_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_discovery_run" ADD CONSTRAINT "moment_discovery_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_discovery_run" ADD CONSTRAINT "moment_discovery_run_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moment_candidate_org_idx" ON "moment_candidate" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "moment_candidate_source_idx" ON "moment_candidate" USING btree ("source_id","rank");--> statement-breakpoint
CREATE INDEX "moment_candidate_run_idx" ON "moment_candidate" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "moment_discovery_run_org_idx" ON "moment_discovery_run" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moment_discovery_run_source_idx" ON "moment_discovery_run" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "moment_discovery_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "moment_discovery_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "moment_discovery_run_org_isolation" ON "moment_discovery_run"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "moment_candidate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "moment_candidate" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "moment_candidate_org_isolation" ON "moment_candidate"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));
