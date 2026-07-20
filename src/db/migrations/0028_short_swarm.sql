CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"credential_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workers_credential_hash_unique" UNIQUE("credential_hash")
);
--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workers_owner_display_name" ON "workers" USING btree ("owner_user_id","display_name");--> statement-breakpoint
CREATE INDEX "idx_workers_owner" ON "workers" USING btree ("owner_user_id");