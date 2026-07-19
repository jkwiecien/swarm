import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per authenticated **SWARM user** — the persisted form of `SwarmUser`
 * (`src/identity/schema.ts`), which stays the source of truth for the shape
 * (ai/CODING_STANDARDS.md "Zod is the source of truth"). The first slice of the
 * multi-user foundation (ADR-001, issue #281).
 *
 * A SWARM user is a person who signs in to this installation — not an SCM
 * identity and not an implementer/reviewer GitHub credential (those live in
 * `project_credentials`). The `id` is generated (`uuid`, `defaultRandom()`) like
 * `review_verdicts`, not externally supplied like a `projects` id.
 *
 * `identifier` is the stable, unique login handle (username/email);
 * `instance_admin` is the single installation-role flag — admin of every
 * project/membership/enrollment (see `InstallationRoleSchema`). It defaults to
 * `false`: the first admin is designated explicitly via the operator CLI
 * (`swarm users add --admin` / `grant-admin`), never implicitly.
 *
 * These rows sit ready for the session-auth follow-up (#281 task 2); nothing in
 * the live auth path reads them yet — the dashboard stays behind
 * `DASHBOARD_TOKEN`.
 */
export const users = pgTable('users', {
	id: uuid('id').primaryKey().defaultRandom(),
	/** Stable, unique login handle (username/email). */
	identifier: text('identifier').notNull().unique(),
	/** Human-friendly label shown in the dashboard. */
	displayName: text('display_name').notNull(),
	/** Installation-admin flag — designated explicitly, never auto-granted. */
	instanceAdmin: boolean('instance_admin').notNull().default(false),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	updatedAt: timestamp('updated_at')
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date()),
});
