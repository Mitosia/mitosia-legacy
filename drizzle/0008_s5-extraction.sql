CREATE TABLE "source_extraction" (
	"classification" text,
	"confidence" real NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"end_ms" integer NOT NULL,
	"grounded" boolean NOT NULL,
	"grounding_score" real NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"organization_id" text NOT NULL,
	"payload" jsonb,
	"revision" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"speaker" text,
	"start_ms" integer NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_extraction_run" (
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
ALTER TABLE "source_extraction" ADD CONSTRAINT "source_extraction_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_extraction" ADD CONSTRAINT "source_extraction_run_id_source_extraction_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."source_extraction_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_extraction" ADD CONSTRAINT "source_extraction_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_extraction_run" ADD CONSTRAINT "source_extraction_run_context_snapshot_id_context_snapshot_id_fk" FOREIGN KEY ("context_snapshot_id") REFERENCES "public"."context_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_extraction_run" ADD CONSTRAINT "source_extraction_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_extraction_run" ADD CONSTRAINT "source_extraction_run_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_extraction_org_idx" ON "source_extraction" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "source_extraction_source_idx" ON "source_extraction" USING btree ("source_id","start_ms");--> statement-breakpoint
CREATE INDEX "source_extraction_run_idx" ON "source_extraction" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "source_extraction_run_org_idx" ON "source_extraction_run" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_extraction_run_source_idx" ON "source_extraction_run" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "source_extraction_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_extraction_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "source_extraction_run_org_isolation" ON "source_extraction_run"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "source_extraction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_extraction" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "source_extraction_org_isolation" ON "source_extraction"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));
