CREATE TABLE "episode_brief" (
	"brief" jsonb NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"model" text NOT NULL,
	"organization_id" text NOT NULL,
	"revision" integer NOT NULL,
	"source_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "moment_candidate" ADD COLUMN "flags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "episode_brief" ADD CONSTRAINT "episode_brief_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_brief" ADD CONSTRAINT "episode_brief_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episode_brief_org_idx" ON "episode_brief" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "episode_brief_source_idx" ON "episode_brief" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "episode_brief" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "episode_brief" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "episode_brief_org_isolation" ON "episode_brief"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));
