import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * One row per SWARM user ↔ provider-handle link — the persisted form of
 * `UserIdentity` (`src/identity/user-identity.ts`), which stays the source of
 * truth for the shape (ai/CODING_STANDARDS.md "Zod is the source of truth"). It
 * is what lets a PM assignee (a provider handle) resolve to a SWARM user for
 * assignee-affinity routing (ADR-001, issue #130).
 *
 * `provider` is a provider-neutral source key stored as free `text` (a `PMType`
 * such as `github-projects`), matching how `project_members.role` persists its
 * enum; `handle` is that provider's login/account id. Both are stored
 * normalized (trimmed + lowercased — `normalizeIdentityKey`), so the unique
 * index below is effectively case-insensitive. `user_id` FKs to `users.id`
 * `ON DELETE CASCADE`, so a link vanishes with its user and never dangles.
 *
 * Unique per `(provider, handle)` — a provider handle belongs to at most one
 * SWARM user, which is what makes resolution unambiguous by construction (no
 * "which of these two users is this assignee?"). The extra `user_id` index
 * serves the reverse listing (`listIdentitiesForUser`).
 */
export const userIdentities = pgTable(
	'user_identities',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** Provider-neutral source key — a `PMType` (`src/pm/types.ts`), normalized. */
		provider: text('provider').notNull(),
		/** The provider's login/account id for this user, normalized. */
		handle: text('handle').notNull(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
	},
	(table) => [
		// A provider handle maps to at most one SWARM user: the resolution identity.
		uniqueIndex('idx_user_identities_provider_handle').on(table.provider, table.handle),
		// The reverse lookup — every handle a user owns (`listIdentitiesForUser`).
		index('idx_user_identities_user').on(table.userId),
	],
);
