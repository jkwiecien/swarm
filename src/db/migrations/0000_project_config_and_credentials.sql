CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repo" text NOT NULL,
	"repo_root" text NOT NULL,
	"worktree_root" text DEFAULT '.swarm-workspaces' NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"branch_prefix" text DEFAULT 'issue-' NOT NULL,
	"pm_type" text DEFAULT 'github-projects' NOT NULL,
	"github_projects" jsonb NOT NULL,
	"credentials" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "projects_repo_unique" UNIQUE("repo")
);
--> statement-breakpoint
CREATE TABLE "project_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"env_var_key" text NOT NULL,
	"value" text NOT NULL,
	"name" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "project_credentials" ADD CONSTRAINT "project_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_credentials_project_env_var_key" ON "project_credentials" USING btree ("project_id","env_var_key");