CREATE TABLE "source_question" (
	"answer" text,
	"answerable" boolean,
	"citations" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	"error" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"metadata" jsonb,
	"organization_id" text NOT NULL,
	"question" text NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_question" ADD CONSTRAINT "source_question_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_question" ADD CONSTRAINT "source_question_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_question" ADD CONSTRAINT "source_question_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_question_org_idx" ON "source_question" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "source_question_source_idx" ON "source_question" USING btree ("source_id","created_at");--> statement-breakpoint
ALTER TABLE "source_question" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_question" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "source_question_org_isolation" ON "source_question"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));