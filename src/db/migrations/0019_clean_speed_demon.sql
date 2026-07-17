CREATE TABLE "review_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"repository" text NOT NULL,
	"pr_number" text NOT NULL,
	"head_sha" text NOT NULL,
	"ordinal" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"verdict" text,
	"review_id" text,
	"reserved_at" timestamp DEFAULT now() NOT NULL,
	"submitted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_ordinal" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_automation_outcome" text;--> statement-breakpoint
ALTER TABLE "review_verdicts" ADD CONSTRAINT "review_verdicts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_review_verdicts_head" ON "review_verdicts" USING btree ("project_id","repository","pr_number","head_sha") WHERE "review_verdicts"."state" <> 'abandoned';--> statement-breakpoint
CREATE INDEX "idx_review_verdicts_pr" ON "review_verdicts" USING btree ("project_id","repository","pr_number");--> statement-breakpoint
CREATE INDEX "idx_review_verdicts_review_id" ON "review_verdicts" USING btree ("review_id");
--> statement-breakpoint
-- Backfill the ledger from already-completed Review runs, so a verdict
-- submitted before this migration still counts toward the two-verdict cap
-- (`review_verdicts` has no history before this deploy). `runs` never stored
-- the reviewed head SHA, so a backfilled row keys on a synthetic
-- `backfill:<run id>` head — it can never collide with a real 40-char git
-- SHA, and it exists only to occupy its ordinal's submitted slot, not to be
-- looked up by a future webhook (a real head SHA always gets its own row via
-- the reservation path from here on).
WITH ranked_runs AS (
	SELECT
		id,
		project_id,
		pr_number,
		review_verdict,
		completed_at,
		ROW_NUMBER() OVER (
			PARTITION BY project_id, pr_number
			ORDER BY completed_at ASC NULLS LAST, started_at ASC
		) AS ordinal
	FROM runs
	WHERE phase = 'review'
		AND status = 'completed'
		AND review_verdict IS NOT NULL
		AND pr_number IS NOT NULL
)
INSERT INTO review_verdicts
	(project_id, repository, pr_number, head_sha, ordinal, state, verdict, reserved_at, submitted_at)
SELECT
	ranked_runs.project_id,
	projects.repo,
	ranked_runs.pr_number,
	'backfill:' || ranked_runs.id,
	ranked_runs.ordinal,
	'submitted',
	ranked_runs.review_verdict,
	COALESCE(ranked_runs.completed_at, now()),
	COALESCE(ranked_runs.completed_at, now())
FROM ranked_runs
JOIN projects ON projects.id = ranked_runs.project_id
WHERE ranked_runs.ordinal <= 2;
--> statement-breakpoint
-- Backfill each historical Review run's own ordinal and, for the second
-- `request-changes` verdict, its manual-intervention outcome — the same
-- fields a live run now records at completion (`src/worker/consumer.ts`).
UPDATE runs
SET review_ordinal = ranked_runs.ordinal
FROM (
	SELECT
		id,
		ROW_NUMBER() OVER (
			PARTITION BY project_id, pr_number
			ORDER BY completed_at ASC NULLS LAST, started_at ASC
		) AS ordinal
	FROM runs
	WHERE phase = 'review'
		AND status = 'completed'
		AND review_verdict IS NOT NULL
		AND pr_number IS NOT NULL
) ranked_runs
WHERE runs.id = ranked_runs.id AND ranked_runs.ordinal <= 2;
--> statement-breakpoint
UPDATE runs
SET review_automation_outcome = 'manual-intervention-required'
WHERE review_ordinal = 2 AND review_verdict = 'request-changes';