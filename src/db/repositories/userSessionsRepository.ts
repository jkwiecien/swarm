/**
 * Dashboard session persistence — plain functions, one `getDb()` per call, no
 * class, mirroring `usersRepository.ts`. Backs the `user_sessions` table
 * (`src/db/schema/userSessions.ts`), the store the cookie-based session auth
 * resolves against (#281 task 2).
 *
 * This layer stores and looks up rows by the **token hash** only; the raw
 * session token never reaches it. Minting the token, hashing it, and setting the
 * cookie are the caller's job (`src/identity/auth.ts` + `src/dashboard.ts`) —
 * this file is the dumb store, so a leaked row can't be replayed as a session.
 */

import { and, eq, gt, lt } from 'drizzle-orm';

import { getDb } from '../client.js';
import { userSessions } from '../schema/userSessions.js';

/** The fields a caller supplies to persist a session; `id`/`createdAt` are generated. */
export interface CreateSessionInput {
	userId: string;
	tokenHash: string;
	expiresAt: Date;
}

/** Insert a session row keyed by the (already hashed) token. */
export async function insertSession(input: CreateSessionInput): Promise<void> {
	await getDb().insert(userSessions).values({
		userId: input.userId,
		tokenHash: input.tokenHash,
		expiresAt: input.expiresAt,
	});
}

/**
 * Resolve the `userId` of a live session by its token hash, or `undefined` when
 * no unexpired session matches — a not-found lookup, not an error
 * (ai/CODING_STANDARDS.md "Error handling"). Expiry is enforced in the query so
 * an expired row never resolves, even before the sweep deletes it.
 */
export async function findUserIdBySessionToken(tokenHash: string): Promise<string | undefined> {
	const rows = await getDb()
		.select({ userId: userSessions.userId })
		.from(userSessions)
		.where(and(eq(userSessions.tokenHash, tokenHash), gt(userSessions.expiresAt, new Date())))
		.limit(1);
	return rows[0]?.userId;
}

/** Delete a session by its token hash (logout). A no-op if none matches. */
export async function deleteSessionByToken(tokenHash: string): Promise<void> {
	await getDb().delete(userSessions).where(eq(userSessions.tokenHash, tokenHash));
}

/**
 * Delete every session that has already expired. Returns the number swept — a
 * cheap housekeeping call the resolve path runs opportunistically so dead rows
 * don't accumulate.
 */
export async function deleteExpiredSessions(): Promise<number> {
	const deleted = await getDb()
		.delete(userSessions)
		.where(lt(userSessions.expiresAt, new Date()))
		.returning({ id: userSessions.id });
	return deleted.length;
}
