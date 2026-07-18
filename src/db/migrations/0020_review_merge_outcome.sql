ALTER TABLE "runs" ADD COLUMN "review_merge_outcome" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_merge_message" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_merge_attempt" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_merge_approved_head_sha" text;