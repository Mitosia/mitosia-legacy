ALTER TABLE "moment_discovery_run" ADD COLUMN "edit_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "moment_discovery_run" ADD COLUMN "human_edited_at" timestamp;--> statement-breakpoint
UPDATE "moment_discovery_run"
SET "counts" = COALESCE("counts", '{}'::jsonb) || '{"dispatchState":"pending"}'::jsonb
WHERE "status" = 'pending';--> statement-breakpoint
UPDATE "moment_discovery_run" AS "run"
SET
	"edit_version" = 1,
	"human_edited_at" = COALESCE(
		(
			SELECT MAX("audit"."created_at")
			FROM "audit_log" AS "audit"
			INNER JOIN "moment_candidate" AS "audited_candidate"
				ON "audited_candidate"."id"::text = "audit"."entity_id"
			WHERE "audited_candidate"."run_id" = "run"."id"
				AND "audit"."action" IN (
					'moment.accepted',
					'moment.shortlisted',
					'moment.rejected',
					'moment.boundaries_adjusted'
				)
		),
		"run"."updated_at"
	)
WHERE EXISTS (
	SELECT 1
	FROM "moment_candidate" AS "candidate"
	WHERE "candidate"."run_id" = "run"."id"
		AND (
			"candidate"."status" <> 'proposed'
			OR "candidate"."adjusted_start_ms" IS NOT NULL
			OR "candidate"."adjusted_end_ms" IS NOT NULL
		)
);
