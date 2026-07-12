CREATE TABLE "run_output_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"content" text NOT NULL,
	"emitted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "output_bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "output_truncated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "run_output_events" ADD CONSTRAINT "run_output_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_output_events_cursor" ON "run_output_events" USING btree ("run_id","id");