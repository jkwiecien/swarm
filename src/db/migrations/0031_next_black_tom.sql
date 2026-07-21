CREATE TABLE "worker_project_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"allowed_clis" jsonb NOT NULL,
	"concurrency_allocation" integer DEFAULT 1 NOT NULL,
	"sharing_consent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_project_enrollments" ADD CONSTRAINT "worker_project_enrollments_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_project_enrollments" ADD CONSTRAINT "worker_project_enrollments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_worker_enrollments_worker_project" ON "worker_project_enrollments" USING btree ("worker_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_worker_enrollments_project" ON "worker_project_enrollments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_worker_enrollments_worker" ON "worker_project_enrollments" USING btree ("worker_id");