/**
 * Worker persistence — plain functions, one `getDb()` per call, no class,
 * mirroring `usersRepository.ts` / `projectMembersRepository.ts`. Backs the
 * `workers` table (`src/db/schema/workers.ts`), the persisted form of `Worker`
 * (`src/identity/worker.ts`, the source of truth for the shape).
 *
 * A `workers` row already carries the domain's exact types, so mapping a row back
 * to `Worker` is a re-assembly, not a re-validation — same as `rowToSwarmUser`
 * (`capabilities` comes back typed from `jsonb` and is cast to `AgentCli[]`, the
 * only values the writers here ever store, exactly as `role`/`status` are cast
 * back in the membership repositories). `rowToWorker` drops `credential_hash`:
 * the credential secret never enters the domain read model, mirroring how
 * `rowToSwarmUser` drops `password_hash`.
 *
 * A duplicate `(owner, displayName)` or `credentialHash` surfaces the raw pg
 * `23505` unique violation; the caller (the `swarm workers` CLI) translates it to
 * a friendly message. Lookups that find nothing return `undefined`/`[]` — a
 * not-found, not an error (ai/CODING_STANDARDS.md "Error handling").
 */

import { asc, eq } from 'drizzle-orm';

import type { AgentCli } from '../../harness/agent-cli.js';
import type { Worker } from '../../identity/worker.js';
import { getDb } from '../client.js';
import { workers } from '../schema/workers.js';

type WorkerRow = typeof workers.$inferSelect;

/** The fields a caller supplies to create a worker; `id`/timestamps are generated. */
export interface CreateWorkerInput {
	ownerUserId: string;
	displayName: string;
	capabilities: AgentCli[];
	/** SHA-256 of the worker credential — never the raw token (see `worker-service.ts`). */
	credentialHash: string;
}

/** Re-assemble a `Worker` from a persisted `workers` row, dropping `credentialHash`. */
function rowToWorker(row: WorkerRow): Worker {
	return {
		id: row.id,
		ownerUserId: row.ownerUserId,
		displayName: row.displayName,
		capabilities: row.capabilities as AgentCli[],
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Create a worker. Rejects with the pg `23505` unique violation if the owner
 * already has a worker by this `displayName`, or if `credentialHash` collides —
 * the caller decides how to surface that.
 */
export async function createWorker(input: CreateWorkerInput): Promise<Worker> {
	const [row] = await getDb()
		.insert(workers)
		.values({
			ownerUserId: input.ownerUserId,
			displayName: input.displayName,
			capabilities: input.capabilities,
			credentialHash: input.credentialHash,
		})
		.returning();
	return rowToWorker(row);
}

/** Resolve a worker by generated id. Returns `undefined` if unknown. */
export async function getWorkerById(id: string): Promise<Worker | undefined> {
	const rows = await getDb().select().from(workers).where(eq(workers.id, id)).limit(1);
	const row = rows[0];
	return row ? rowToWorker(row) : undefined;
}

/** List every worker an owner operates, oldest first. Empty if they operate none. */
export async function listWorkersForOwner(ownerUserId: string): Promise<Worker[]> {
	const rows = await getDb()
		.select()
		.from(workers)
		.where(eq(workers.ownerUserId, ownerUserId))
		.orderBy(asc(workers.createdAt), asc(workers.id));
	return rows.map(rowToWorker);
}

/**
 * Resolve a worker by its credential hash — the authentication seam (the analogue
 * of `findUserIdBySessionToken`). Returns the domain `Worker` (still no hash) so
 * callers get an authenticated identity, or `undefined` when no worker matches —
 * a not-found lookup, not an error.
 */
export async function findWorkerByCredentialHash(hash: string): Promise<Worker | undefined> {
	const rows = await getDb()
		.select()
		.from(workers)
		.where(eq(workers.credentialHash, hash))
		.limit(1);
	const row = rows[0];
	return row ? rowToWorker(row) : undefined;
}

/**
 * Replace a worker's declared capabilities. Returns the updated worker, or
 * `undefined` if no worker has that id (nothing to update).
 */
export async function updateWorkerCapabilities(
	id: string,
	capabilities: AgentCli[],
): Promise<Worker | undefined> {
	const [row] = await getDb()
		.update(workers)
		.set({ capabilities })
		.where(eq(workers.id, id))
		.returning();
	return row ? rowToWorker(row) : undefined;
}

/**
 * Remove a worker (owner deregistration). Returns `true` if a worker was removed,
 * `false` if none had that id (a no-op, not an error).
 */
export async function removeWorker(id: string): Promise<boolean> {
	const rows = await getDb()
		.delete(workers)
		.where(eq(workers.id, id))
		.returning({ id: workers.id });
	return rows.length > 0;
}
