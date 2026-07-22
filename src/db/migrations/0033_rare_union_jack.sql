ALTER TABLE "runs" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "worker_fencing_token" bigint;--> statement-breakpoint
ALTER TABLE "dispatches" ADD COLUMN "selected_worker_id" uuid;--> statement-breakpoint
ALTER TABLE "dispatches" ADD COLUMN "worker_session_id" uuid;--> statement-breakpoint
ALTER TABLE "dispatches" ADD COLUMN "worker_fencing_token" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_selected_worker_id_workers_id_fk" FOREIGN KEY ("selected_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_worker_session_id_worker_sessions_id_fk" FOREIGN KEY ("worker_session_id") REFERENCES "public"."worker_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_runs_worker_id" ON "runs" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "idx_dispatches_selected_worker" ON "dispatches" USING btree ("selected_worker_id","state");