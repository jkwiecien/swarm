CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text,
	"phase" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"wait_reason" text,
	"outcome" text,
	"dedup_key" text,
	"coalesce_key" text,
	"continuation" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"wake_seq" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"job_payload" jsonb NOT NULL,
	"run_id" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp,
	"last_error" text,
	"source" text DEFAULT 'webhook' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dispatches_dedup_key" ON "dispatches" USING btree ("dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dispatches_active_run" ON "dispatches" USING btree ("run_id") WHERE state IN ('pending', 'leased', 'running', 'retry-scheduled');--> statement-breakpoint
CREATE INDEX "idx_dispatches_state" ON "dispatches" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_dispatches_project_state" ON "dispatches" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "idx_dispatches_coalesce_key" ON "dispatches" USING btree ("coalesce_key");