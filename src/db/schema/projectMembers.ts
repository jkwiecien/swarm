import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { users } from './users.js';

/**
 * One row per project membership — the persisted form of `ProjectMembership`
 * (`src/identity/membership.ts`), which stays the source of truth for the shape
 * (ai/CODING_STANDARDS.md "Zod is the source of truth"). The second slice of the
 * multi-user foundation (ADR-001, issue #281): it links a `users` row to a
 * `projects` row with one per-project `role`.
 *
 * `role` is stored as free `text` (the Zod `ProjectRoleSchema` enum is the
 * source of truth for the allowed values), matching how `review_verdicts.state`
 * persists its enum. `project_id` is `text` (a `projects.id`), `user_id` is
 * `uuid` (a `users.id`); both FKs `ON DELETE CASCADE`, so a membership vanishes
 * with either its project or its user and never dangles.
 *
 * Unique per `(project_id, user_id)` — a user holds at most one role per
 * project; a re-add is an update, not a second row. The extra `user_id` index
 * serves `listProjectsForUser` (the reverse lookup, not covered by the
 * project-first unique index).
 *
 * Like the rest of the multi-user foundation this is inert for now: no router
 * reads it yet — it is the read model authorization (a later #281 task) builds on.
 */
export const projectMembers = pgTable(
	'project_members',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** One of `ProjectRoleSchema` (`src/identity/membership.ts`) — the source of truth for the values. */
		role: text('role').notNull(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
	},
	(table) => [
		// At most one role per (project, user): the membership identity.
		uniqueIndex('idx_project_members_project_user').on(table.projectId, table.userId),
		// The reverse lookup — every project a user belongs to (`listProjectsForUser`).
		index('idx_project_members_user').on(table.userId),
	],
);
