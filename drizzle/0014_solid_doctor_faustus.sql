ALTER TABLE "segment_plan_run" ADD COLUMN "edit_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "segment_plan_run" ADD COLUMN "human_edited_at" timestamp;--> statement-breakpoint
UPDATE "segment_plan_run"
SET "counts" = COALESCE("counts", '{}'::jsonb) || '{"dispatchState":"pending"}'::jsonb
WHERE "status" = 'pending';--> statement-breakpoint
UPDATE "segment_clip" AS "clip"
SET
	"anchor_text" = NULL,
	"decided_at" = CASE WHEN "clip"."status" = 'rejected' THEN "clip"."decided_at" ELSE NULL END,
	"decided_by" = CASE WHEN "clip"."status" = 'rejected' THEN "clip"."decided_by" ELSE NULL END,
	"drop_reason" = NULL,
	"flags" = "clip"."flags" || '["human_restored","needs_metadata_review","no_anchor"]'::jsonb,
	"grounded" = false,
	"grounding_score" = 0,
	"kind" = 'keep',
	"reject_note" = CASE WHEN "clip"."status" = 'rejected' THEN "clip"."reject_note" ELSE NULL END,
	"reject_reason" = CASE WHEN "clip"."status" = 'rejected' THEN "clip"."reject_reason" ELSE NULL END,
	"review_fix" = NULL,
	"review_notes" = NULL,
	"review_scores" = NULL,
	"status" = CASE WHEN "clip"."status" = 'rejected' THEN 'rejected' ELSE 'proposed' END
WHERE EXISTS (
	SELECT 1
	FROM "audit_log" AS "audit"
	WHERE "audit"."entity_id" = "clip"."id"::text
		AND "audit"."action" = 'segment.restored'
);--> statement-breakpoint
UPDATE "segment_plan_run" AS "run"
SET
	"edit_version" = 1,
	"human_edited_at" = COALESCE(
		(
			SELECT MAX("audit"."created_at")
			FROM "audit_log" AS "audit"
			INNER JOIN "segment_clip" AS "audited_clip"
				ON "audited_clip"."id"::text = "audit"."entity_id"
			WHERE "audited_clip"."run_id" = "run"."id"
				AND "audit"."action" IN (
					'segment.boundaries_adjusted',
					'segment.restored'
				)
		),
		"run"."updated_at"
	)
WHERE EXISTS (
	SELECT 1
	FROM "segment_clip" AS "clip"
	WHERE "clip"."run_id" = "run"."id"
		AND (
			"clip"."adjusted_start_ms" IS NOT NULL
			OR "clip"."adjusted_end_ms" IS NOT NULL
			OR "clip"."status" <> 'proposed'
		)
)
OR EXISTS (
	SELECT 1
	FROM "audit_log" AS "audit"
	INNER JOIN "segment_clip" AS "audited_clip"
		ON "audited_clip"."id"::text = "audit"."entity_id"
	WHERE "audited_clip"."run_id" = "run"."id"
		AND "audit"."action" IN (
			'segment.boundaries_adjusted',
			'segment.restored'
		)
);--> statement-breakpoint
UPDATE "segment_plan_run" AS "run"
SET
	"error" = 'This plan contains legacy one-sided boundary edits. Re-plan it to restore a safe shared-cut partition.',
	"status" = 'failed'
WHERE "run"."status" = 'ready'
	AND EXISTS (
		SELECT 1
		FROM "segment_clip" AS "clip"
		WHERE "clip"."run_id" = "run"."id"
			AND (
				"clip"."adjusted_start_ms" IS NOT NULL
				OR "clip"."adjusted_end_ms" IS NOT NULL
			)
	);
