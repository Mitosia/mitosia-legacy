CREATE TABLE "transcript" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"language" text,
	"model" text,
	"organization_id" text NOT NULL,
	"provider" text,
	"source_id" uuid NOT NULL,
	"speaker_labels" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_revision" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"metadata" jsonb,
	"organization_id" text NOT NULL,
	"revision" integer NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"transcript_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transcript" ADD CONSTRAINT "transcript_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript" ADD CONSTRAINT "transcript_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_revision" ADD CONSTRAINT "transcript_revision_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_revision" ADD CONSTRAINT "transcript_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_revision" ADD CONSTRAINT "transcript_revision_transcript_id_transcript_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcript"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_org_idx" ON "transcript" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_source_idx" ON "transcript" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "transcript_revision_org_idx" ON "transcript_revision" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_revision_seq_idx" ON "transcript_revision" USING btree ("transcript_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_revision_storage_key_idx" ON "transcript_revision" USING btree ("storage_key");--> statement-breakpoint
ALTER TABLE "transcript" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transcript" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "transcript_org_isolation" ON "transcript"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "transcript_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transcript_revision" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "transcript_revision_org_isolation" ON "transcript_revision"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));