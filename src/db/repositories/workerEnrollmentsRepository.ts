/**
 * Worker-enrollment persistence — plain functions, one `getDb()` per call, no
 * class, mirroring `workersRepository.ts` / `projectMembersRepository.ts`. Backs
 * the `worker_project_enrollments` table (`src/db/schema/workerProjectEnrollments.ts`),
 * the persisted form of `WorkerEnrollment` (`src/identity/worker-enrollment.ts`,
 * the source of truth for the shape). Phase 3 of the worker slice.
 *
 * A row already carries the domain's exact types, so mapping it back to
 * `WorkerEnrollment` is a re-assembly, not a re-validation — same as
 * `rowToWorker` (`allowedClis` comes back typed from `jsonb` and is cast to
 * `AgentCli[]`, `status` is cast back to the `EnrollmentStatus` enum the writers
 * here only ever store). Creating a second enrollment for the same
 * `(worker, project)` surfaces the raw pg `23505` unique violation; the caller
 * translates it. Lookups that find nothing return `undefined`/`[]` — a
 * not-found, not an error (ai/CODING_STANDARDS.md "Error handling").
 */

import { and, asc, eq } from 'drizzle-orm';

import type { AgentCli } from '../../harness/agent-cli.js';
import type { EnrollmentStatus, WorkerEnrollment } from '../../identity/worker-enrollment.js';
import { getDb } from '../client.js';
import { workerProjectEnrollments } from '../schema/workerProjectEnrollments.js';

type EnrollmentRow = typeof workerProjectEnrollments.$inferSelect;

/** Re-assemble a `WorkerEnrollment` from a persisted `worker_project_enrollments` row. */
function rowToEnrollment(row: EnrollmentRow): WorkerEnrollment {
	return {
		id: row.id,
		workerId: row.workerId,
		projectId: row.projectId,
		status: row.status as EnrollmentStatus,
		allowedClis: row.allowedClis as AgentCli[],
		concurrencyAllocation: row.concurrencyAllocation,
		sharingConsent: row.sharingConsent,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** The fields a caller supplies to create an enrollment; `id`/timestamps are generated. */
export interface CreateEnrollmentInput {
	workerId: string;
	projectId: string;
	status: EnrollmentStatus;
	allowedClis: AgentCli[];
	concurrencyAllocation: number;
	sharingConsent: boolean;
}

/**
 * Create an enrollment. Rejects with the pg `23505` unique violation if this
 * worker already has an enrollment for this project (at most one per
 * `(worker, project)`) — changing an existing enrollment is
 * {@link updateEnrollmentConstraints} / {@link updateEnrollmentStatus}, not a re-create.
 */
export async function createEnrollment(input: CreateEnrollmentInput): Promise<WorkerEnrollment> {
	const [row] = await getDb()
		.insert(workerProjectEnrollments)
		.values({
			workerId: input.workerId,
			projectId: input.projectId,
			status: input.status,
			allowedClis: input.allowedClis,
			concurrencyAllocation: input.concurrencyAllocation,
			sharingConsent: input.sharingConsent,
		})
		.returning();
	return rowToEnrollment(row);
}

/** Resolve an enrollment by its generated id. Returns `undefined` if unknown. */
export async function getEnrollmentById(id: string): Promise<WorkerEnrollment | undefined> {
	const rows = await getDb()
		.select()
		.from(workerProjectEnrollments)
		.where(eq(workerProjectEnrollments.id, id))
		.limit(1);
	const row = rows[0];
	return row ? rowToEnrollment(row) : undefined;
}

/** Resolve a worker's enrollment for one project, or `undefined` if it has none. */
export async function getEnrollment(
	workerId: string,
	projectId: string,
): Promise<WorkerEnrollment | undefined> {
	const rows = await getDb()
		.select()
		.from(workerProjectEnrollments)
		.where(
			and(
				eq(workerProjectEnrollments.workerId, workerId),
				eq(workerProjectEnrollments.projectId, projectId),
			),
		)
		.limit(1);
	const row = rows[0];
	return row ? rowToEnrollment(row) : undefined;
}

/** List every enrollment of a project, oldest first — the roster read. Empty if none. */
export async function listEnrollmentsForProject(projectId: string): Promise<WorkerEnrollment[]> {
	const rows = await getDb()
		.select()
		.from(workerProjectEnrollments)
		.where(eq(workerProjectEnrollments.projectId, projectId))
		.orderBy(asc(workerProjectEnrollments.createdAt), asc(workerProjectEnrollments.id));
	return rows.map(rowToEnrollment);
}

/** List every enrollment a worker holds, oldest first — the owner self-service read. Empty if none. */
export async function listEnrollmentsForWorker(workerId: string): Promise<WorkerEnrollment[]> {
	const rows = await getDb()
		.select()
		.from(workerProjectEnrollments)
		.where(eq(workerProjectEnrollments.workerId, workerId))
		.orderBy(asc(workerProjectEnrollments.createdAt), asc(workerProjectEnrollments.id));
	return rows.map(rowToEnrollment);
}

/**
 * Transition an enrollment's `status` (approve → `active`, revoke → `suspended`,
 * or back). Returns the updated enrollment, or `undefined` if no enrollment has
 * that id (nothing to update). Flipping to a non-`active` status is what makes
 * `isRoutable` false without deleting the row — the worker and its session are
 * untouched.
 */
export async function updateEnrollmentStatus(
	id: string,
	status: EnrollmentStatus,
): Promise<WorkerEnrollment | undefined> {
	const [row] = await getDb()
		.update(workerProjectEnrollments)
		.set({ status })
		.where(eq(workerProjectEnrollments.id, id))
		.returning();
	return row ? rowToEnrollment(row) : undefined;
}

/**
 * Set (or revoke, with `false`) the owner-controlled sharing consent. Returns
 * the updated enrollment, or `undefined` if no enrollment has that id. Revoking
 * consent flips `isRoutable` false — blocking future dispatch — without touching
 * the worker, its session, or any running process.
 */
export async function setEnrollmentSharingConsent(
	id: string,
	sharingConsent: boolean,
): Promise<WorkerEnrollment | undefined> {
	const [row] = await getDb()
		.update(workerProjectEnrollments)
		.set({ sharingConsent })
		.where(eq(workerProjectEnrollments.id, id))
		.returning();
	return row ? rowToEnrollment(row) : undefined;
}

/** The mutable execution constraints; each field is optional so a caller updates only what changed. */
export interface UpdateEnrollmentConstraintsInput {
	allowedClis?: AgentCli[];
	concurrencyAllocation?: number;
}

/**
 * Update an enrollment's execution constraints (`allowedClis` and/or
 * `concurrencyAllocation`). A no-field update is a no-op that still returns the
 * current row. Returns `undefined` if no enrollment has that id.
 */
export async function updateEnrollmentConstraints(
	id: string,
	input: UpdateEnrollmentConstraintsInput,
): Promise<WorkerEnrollment | undefined> {
	const patch: Partial<Pick<EnrollmentRow, 'allowedClis' | 'concurrencyAllocation'>> = {};
	if (input.allowedClis !== undefined) patch.allowedClis = input.allowedClis;
	if (input.concurrencyAllocation !== undefined) {
		patch.concurrencyAllocation = input.concurrencyAllocation;
	}
	if (Object.keys(patch).length === 0) {
		return getEnrollmentById(id);
	}
	const [row] = await getDb()
		.update(workerProjectEnrollments)
		.set(patch)
		.where(eq(workerProjectEnrollments.id, id))
		.returning();
	return row ? rowToEnrollment(row) : undefined;
}

/**
 * Remove an enrollment (hard delete). Returns `true` if one was removed, `false`
 * if none had that id (a no-op, not an error). Note revocation is normally a
 * `suspended` status transition, not a delete, so the constraints survive a
 * later re-activation.
 */
export async function removeEnrollment(id: string): Promise<boolean> {
	const rows = await getDb()
		.delete(workerProjectEnrollments)
		.where(eq(workerProjectEnrollments.id, id))
		.returning({ id: workerProjectEnrollments.id });
	return rows.length > 0;
}
