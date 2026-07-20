import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { users } from './users.js';

/**
 * One row per project membership request — the persisted form of
 * `MembershipRequest` (`src/identity/membership-request.ts`), which stays the
 * source of truth for the shape (ai/CODING_STANDARDS.md "Zod is the source of
 * truth"). The open-project join flow of the multi-user foundation (ADR-001,
 * issue #281 task 5): a user asks to join a `discoverable` project, and a
 * `projectAdmin`/`instanceAdmin` approves (creating a `contributor`
 * `project_members` row) or rejects.
 *
 * Mirrors `project_members` (`./projectMembers.ts`): `project_id` is `text` (a
 * `projects.id`), `user_id` is `uuid` (a `users.id`), both FKs `ON DELETE
 * CASCADE` so a request vanishes with either its project or its user. `status`
 * is stored as free `text` (the Zod `MembershipRequestStatusSchema` enum is the
 * source of truth for the values), matching how `project_members.role` and
 * `review_verdicts.state` persist their enums.
 *
 * The partial unique index allows at most one **pending** request per
 * `(project_id, user_id)` — a resolved (approved/rejected) request never blocks
 * the requester from filing a fresh one, but a duplicate pending request is
 * rejected at the database. Joining grants no access on its own: approval, not
 * the request, is what creates a membership, and it is only ever `contributor`.
 */
export const projectMembershipRequests = pgTable(
	'project_membership_requests',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** One of `MembershipRequestStatusSchema` (`src/identity/membership-request.ts`) — the source of truth for the values. */
		status: text('status').notNull().default('pending'),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		// At most one *pending* request per (project, user); a resolved request
		// never blocks a fresh one (partial index on the pending state).
		uniqueIndex('idx_membership_requests_pending')
			.on(table.projectId, table.userId)
			.where(sql`${table.status} = 'pending'`),
		// The admin-facing lookup — every request for a project (`listPendingRequestsForProject`).
		index('idx_membership_requests_project').on(table.projectId),
	],
);
