import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * One row per live dashboard **session** — the persisted backing for the
 * cookie-based session auth that replaces the shared `DASHBOARD_TOKEN` bearer
 * guard (#281 task 2). A session belongs to exactly one `users` row and is
 * created on login, resolved on every authenticated request, and deleted on
 * logout (or when it expires).
 *
 * **No secret is stored here.** `token_hash` is a SHA-256 of the opaque session
 * token; the raw token lives only in the user's HTTP-only cookie and is returned
 * to the browser exactly once, when the cookie is set at login. A stolen row
 * therefore can't be replayed as a session — the same reasoning behind hashing a
 * password rather than storing it (`src/identity/auth.ts`). `expires_at` is an
 * absolute cutoff checked at resolve time; `cascade` on the FK means deleting a
 * user drops their sessions too.
 */
export const userSessions = pgTable(
	'user_sessions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** SHA-256 of the opaque session token — never the raw token itself. */
		tokenHash: text('token_hash').notNull().unique(),
		/** Absolute expiry; a session resolving after this instant is rejected. */
		expiresAt: timestamp('expires_at').notNull(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
	},
	(table) => [
		// Every resolve hashes the cookie token and looks the row up by that hash
		// (the unique constraint already indexes it); this index serves the
		// revoke-all-for-a-user / cascade-delete path.
		index('idx_user_sessions_user_id').on(table.userId),
	],
);
