CREATE TABLE "source" (
	"created_by" text,
	"duration_seconds" double precision,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ingest_attempts" integer DEFAULT 0 NOT NULL,
	"ingest_error" text,
	"ingest_step" text,
	"metadata" jsonb,
	"mime_type" text NOT NULL,
	"organization_id" text NOT NULL,
	"original_filename" text NOT NULL,
	"project_id" uuid NOT NULL,
	"size_bytes" bigint,
	"status" text DEFAULT 'uploading' NOT NULL,
	"storage_key" text NOT NULL,
	"title" text NOT NULL,
	"upload_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_artifact" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"metadata" jsonb,
	"mime_type" text NOT NULL,
	"organization_id" text NOT NULL,
	"size_bytes" bigint,
	"source_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"correlation_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"entry_type" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"metadata" jsonb,
	"organization_id" text NOT NULL,
	"quantity" double precision NOT NULL,
	"source_id" uuid,
	"unit" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifact" ADD CONSTRAINT "source_artifact_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifact" ADD CONSTRAINT "source_artifact_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_org_idx" ON "source" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "source_project_idx" ON "source" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_storage_key_idx" ON "source" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "source_artifact_org_idx" ON "source_artifact" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "source_artifact_source_idx" ON "source_artifact" USING btree ("source_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "source_artifact_storage_key_idx" ON "source_artifact" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "usage_ledger_org_idx" ON "usage_ledger" USING btree ("organization_id","entry_type");--> statement-breakpoint
CREATE INDEX "usage_ledger_source_idx" ON "usage_ledger" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_correlation_idx" ON "usage_ledger" USING btree ("correlation_id");--> statement-breakpoint

-- Tenant isolation (same pattern as 0002): scoped to the transaction-local
-- app.organization_id set by withOrgScope(); FORCE because the app may
-- connect as table owner in some environments; fail closed without context.

ALTER TABLE "source" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "source_org_isolation" ON "source"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint

ALTER TABLE "source_artifact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_artifact" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "source_artifact_org_isolation" ON "source_artifact"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint

-- usage_ledger is append-only BY POLICY SHAPE: only SELECT and INSERT
-- policies exist, so UPDATE and DELETE are denied outright for the app
-- role — even inside its own organization. Corrections are compensating
-- entries, never edits.
ALTER TABLE "usage_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "usage_ledger_org_select" ON "usage_ledger" FOR SELECT
  USING ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "usage_ledger_org_insert" ON "usage_ledger" FOR INSERT
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));
