/**
 * SWARM user persistence — plain functions, one `getDb()` per call, no class,
 * mirroring `projectsRepository.ts` / `appSettingsRepository.ts`. Backs the
 * `users` table (`src/db/schema/users.ts`), the persisted form of `SwarmUser`
 * (`src/identity/schema.ts`, the source of truth for the shape).
 *
 * A `users` row already carries the domain's exact types (`uuid`, `text`,
 * `boolean`, `timestamp`), so mapping a row back to `SwarmUser` is a re-assembly,
 * not a re-validation — same as `rowToProjectConfig`. A duplicate `identifier`
 * surfaces the raw pg `23505` unique violation; the caller (the `swarm users`
 * CLI) translates it to a friendly message.
 */

import { asc, eq } from 'drizzle-orm';

import type { SwarmUser } from '../../identity/schema.js';
import { getDb } from '../client.js';
import { users } from '../schema/users.js';

type UserRow = typeof users.$inferSelect;

/** The fields a caller supplies to create a user; `id`/timestamps are generated. */
export interface CreateUserInput {
	identifier: string;
	displayName: string;
	instanceAdmin?: boolean;
}

/** Re-assemble a `SwarmUser` from a persisted `users` row. */
function rowToSwarmUser(row: UserRow): SwarmUser {
	return {
		id: row.id,
		identifier: row.identifier,
		displayName: row.displayName,
		instanceAdmin: row.instanceAdmin,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Create a user. Rejects with the pg `23505` unique violation if `identifier`
 * already exists (the identifier is the stable, unique login handle) — the
 * caller decides how to surface that.
 */
export async function createUser(input: CreateUserInput): Promise<SwarmUser> {
	const [row] = await getDb()
		.insert(users)
		.values({
			identifier: input.identifier,
			displayName: input.displayName,
			instanceAdmin: input.instanceAdmin ?? false,
		})
		.returning();
	return rowToSwarmUser(row);
}

/** Resolve a user by generated id. Returns `undefined` if unknown. */
export async function getUserById(id: string): Promise<SwarmUser | undefined> {
	const rows = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
	const row = rows[0];
	return row ? rowToSwarmUser(row) : undefined;
}

/**
 * Resolve a user by their login handle. Returns `undefined` when no user owns
 * that identifier — a not-found lookup, not an error (ai/CODING_STANDARDS.md
 * "Error handling").
 */
export async function findUserByIdentifier(identifier: string): Promise<SwarmUser | undefined> {
	const rows = await getDb().select().from(users).where(eq(users.identifier, identifier)).limit(1);
	const row = rows[0];
	return row ? rowToSwarmUser(row) : undefined;
}

/** List all users, ordered by identifier. */
export async function listUsers(): Promise<SwarmUser[]> {
	const rows = await getDb().select().from(users).orderBy(asc(users.identifier));
	return rows.map(rowToSwarmUser);
}

/**
 * Set (grant/revoke) a user's installation-admin flag. Returns the updated user,
 * or `undefined` if no user has that id.
 */
export async function setInstanceAdmin(id: string, value: boolean): Promise<SwarmUser | undefined> {
	const [row] = await getDb()
		.update(users)
		.set({ instanceAdmin: value })
		.where(eq(users.id, id))
		.returning();
	return row ? rowToSwarmUser(row) : undefined;
}

/**
 * The credential material for a login attempt — the user plus their stored
 * password hash. Kept separate from `SwarmUser` on purpose: the hash is a secret
 * that must never leak into the domain read model or any response, so only the
 * auth path (`src/identity/auth.ts`) reads it via this function.
 */
export interface UserCredential {
	user: SwarmUser;
	passwordHash: string | null;
}

/**
 * Resolve a user and their password hash by login handle, for credential
 * verification. Returns `undefined` when no user owns that identifier; the hash
 * is `null` when the user exists but has no password set (they can't log in).
 */
export async function findUserCredentialByIdentifier(
	identifier: string,
): Promise<UserCredential | undefined> {
	const rows = await getDb().select().from(users).where(eq(users.identifier, identifier)).limit(1);
	const row = rows[0];
	return row ? { user: rowToSwarmUser(row), passwordHash: row.passwordHash } : undefined;
}

/**
 * Store (or replace) a user's password hash. Returns `true` when a row was
 * updated, `false` when no user has that id. The caller passes an already-hashed
 * value — this layer never sees a plaintext password.
 */
export async function setPasswordHash(id: string, passwordHash: string): Promise<boolean> {
	const updated = await getDb()
		.update(users)
		.set({ passwordHash })
		.where(eq(users.id, id))
		.returning({ id: users.id });
	return updated.length > 0;
}
