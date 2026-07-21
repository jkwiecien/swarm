/**
 * Provider-neutral **worker-enrollment** surface — the seam the tRPC `workers`
 * router, the `swarm workers` CLI, and (later) the #130 dispatch gate program
 * against so they never touch the `worker_project_enrollments` table directly.
 * Phase 3 of the worker slice, on top of Phase 1's identity
 * (`./worker-service.ts`) and Phase 2's sessions (`./worker-session-service.ts`),
 * and the enrollment-side companion to the membership read model
 * (`./membership-service.ts`).
 *
 * It owns both the enrollment write operations (`enrollWorker` /
 * `approveEnrollment` / `setSharingConsent` / `updateEnrollmentConstraints` /
 * `setEnrollmentStatus`) and the two provider-neutral read models:
 *
 * - `listProjectRoster(projectId)` — every worker enrolled in a project, with
 *   display name, owner, capabilities, status, allowed CLIs, concurrency,
 *   sharing consent, the derived {@link isRoutable} verdict, and derived
 *   busy/current-run state.
 * - `listOwnerWorkers(ownerUserId)` — an owner's self-service view of their own
 *   workers and each worker's enrollments across projects.
 *
 * **No secrets** leave this surface. The assembled views are built by explicitly
 * naming the safe fields (never spreading a row), so a repo path, PAT, local
 * CLI token, or credential hash can never ride along — the `Worker` read model
 * already omits the credential hash, and this layer never reaches for project
 * config, credentials, or worktree paths.
 *
 * **Busy/current-run is derived from run lifecycle, never client-supplied**:
 * `deriveWorkerRunState` reads the worker's *live* Phase-2 session
 * (`getLiveSessionForWorker`) and, only when that session points at a run that
 * is actually `running` in the `runs` table, reports the worker busy. A stale
 * `current_run_id` left over from a completed/failed run reads as idle.
 */

import { getRunByIdFromDb } from '../db/repositories/runsRepository.js';
import { getUserById } from '../db/repositories/usersRepository.js';
import {
	createEnrollment,
	getEnrollmentById,
	listEnrollmentsForProject,
	listEnrollmentsForWorker,
	setEnrollmentSharingConsent,
	updateEnrollmentConstraints as updateEnrollmentConstraintsRow,
	updateEnrollmentStatus,
} from '../db/repositories/workerEnrollmentsRepository.js';
import { getWorkerById, listWorkersForOwner } from '../db/repositories/workersRepository.js';
import type { AgentCli } from '../harness/agent-cli.js';
import type { Worker } from './worker.js';
import {
	ConcurrencyAllocationSchema,
	EnrollmentAllowedClisSchema,
	type EnrollmentStatus,
	isRoutable,
	type WorkerEnrollment,
} from './worker-enrollment.js';
import { getLiveSessionForWorker } from './worker-session-service.js';

export {
	ConcurrencyAllocationSchema,
	ENROLLMENT_STATUSES,
	EnrollmentAllowedClisSchema,
	type EnrollmentStatus,
	EnrollmentStatusSchema,
	isRoutable,
	type WorkerEnrollment,
} from './worker-enrollment.js';

/**
 * Raised when an enrollment's `allowedClis` are not a subset of the worker's
 * declared `capabilities` — a worker cannot be permitted to run a CLI it never
 * declared it can run. A distinct type so the router can surface it as a
 * `BAD_REQUEST` rather than an unexpected failure.
 */
export class AllowedClisNotCapableError extends Error {
	constructor(
		public readonly workerId: string,
		public readonly offending: AgentCli[],
	) {
		super(
			`Worker ${workerId} cannot be enrolled to run CLIs it does not declare: ${offending.join(', ')}`,
		);
		this.name = 'AllowedClisNotCapableError';
	}
}

/**
 * Derived run state for a worker — never client-supplied. `busy` is `true` only
 * while the worker's live session points at a run that is actually `running`;
 * `currentRunId` is that run's id, or `null` when idle.
 */
export interface WorkerRunState {
	busy: boolean;
	currentRunId: string | null;
}

/** The owner shown on a roster entry — a non-secret identity, never a credential. */
export interface RosterOwner {
	userId: string;
	identifier: string;
	displayName: string;
}

/** One row of the project roster read model — secret-free by construction. */
export interface WorkerRosterEntry {
	enrollmentId: string;
	workerId: string;
	projectId: string;
	displayName: string;
	owner: RosterOwner | null;
	capabilities: AgentCli[];
	status: EnrollmentStatus;
	allowedClis: AgentCli[];
	concurrencyAllocation: number;
	sharingConsent: boolean;
	isRoutable: boolean;
	runState: WorkerRunState;
}

/** One enrollment in an owner's self-service view — secret-free by construction. */
export interface OwnerEnrollmentView {
	enrollmentId: string;
	projectId: string;
	status: EnrollmentStatus;
	allowedClis: AgentCli[];
	concurrencyAllocation: number;
	sharingConsent: boolean;
	isRoutable: boolean;
}

/** One worker in an owner's self-service view, with its enrollments — secret-free by construction. */
export interface OwnerWorkerView {
	workerId: string;
	displayName: string;
	capabilities: AgentCli[];
	runState: WorkerRunState;
	enrollments: OwnerEnrollmentView[];
}

/**
 * Derive a worker's busy/current-run state from the run lifecycle. Reads the
 * worker's *live* Phase-2 session; a worker with no live session (never
 * acquired, expired, or released) is idle. When the live session points at a
 * `current_run_id`, the run is looked up in `runs` and the worker is `busy`
 * **only if** that run's status is `running` — a stale pointer to a
 * completed/failed run reads as idle. The status is read from `runs`, never
 * trusted from a caller.
 */
export async function deriveWorkerRunState(workerId: string): Promise<WorkerRunState> {
	const session = await getLiveSessionForWorker(workerId);
	if (!session?.currentRunId) return { busy: false, currentRunId: null };
	const run = await getRunByIdFromDb(session.currentRunId);
	if (run && run.status === 'running') {
		return { busy: true, currentRunId: run.id };
	}
	return { busy: false, currentRunId: null };
}

/** Assemble one roster entry from an enrollment + its worker + owner + derived run state. */
function assembleRosterEntry(
	enrollment: WorkerEnrollment,
	worker: Worker,
	owner: RosterOwner | null,
	runState: WorkerRunState,
): WorkerRosterEntry {
	return {
		enrollmentId: enrollment.id,
		workerId: worker.id,
		projectId: enrollment.projectId,
		displayName: worker.displayName,
		owner,
		capabilities: worker.capabilities,
		status: enrollment.status,
		allowedClis: enrollment.allowedClis,
		concurrencyAllocation: enrollment.concurrencyAllocation,
		sharingConsent: enrollment.sharingConsent,
		isRoutable: isRoutable(enrollment),
		runState,
	};
}

/** Assemble one owner-view enrollment (no worker/owner fields — the owner already knows those). */
function assembleOwnerEnrollmentView(enrollment: WorkerEnrollment): OwnerEnrollmentView {
	return {
		enrollmentId: enrollment.id,
		projectId: enrollment.projectId,
		status: enrollment.status,
		allowedClis: enrollment.allowedClis,
		concurrencyAllocation: enrollment.concurrencyAllocation,
		sharingConsent: enrollment.sharingConsent,
		isRoutable: isRoutable(enrollment),
	};
}

/**
 * The provider-neutral project roster: every worker enrolled in `projectId`,
 * with the secret-free view and derived busy/current-run state. **Project
 * isolation** falls out of the query being keyed on `projectId` — a worker
 * enrolled only in another project never appears here. Empty if the project has
 * no enrollments. An enrollment whose worker vanished (should not happen — the
 * FK cascades) is skipped defensively.
 */
export async function listProjectRoster(projectId: string): Promise<WorkerRosterEntry[]> {
	const enrollments = await listEnrollmentsForProject(projectId);
	const entries: WorkerRosterEntry[] = [];
	for (const enrollment of enrollments) {
		const worker = await getWorkerById(enrollment.workerId);
		if (!worker) continue;
		const ownerUser = await getUserById(worker.ownerUserId);
		const owner: RosterOwner | null = ownerUser
			? {
					userId: ownerUser.id,
					identifier: ownerUser.identifier,
					displayName: ownerUser.displayName,
				}
			: null;
		const runState = await deriveWorkerRunState(worker.id);
		entries.push(assembleRosterEntry(enrollment, worker, owner, runState));
	}
	return entries;
}

/**
 * The owner self-service view: every worker `ownerUserId` operates, each with
 * its enrollments across projects and its derived run state. Scoped strictly to
 * the owner's own workers, so it returns nothing for a user who operates none.
 */
export async function listOwnerWorkers(ownerUserId: string): Promise<OwnerWorkerView[]> {
	const workers = await listWorkersForOwner(ownerUserId);
	const views: OwnerWorkerView[] = [];
	for (const worker of workers) {
		const enrollments = await listEnrollmentsForWorker(worker.id);
		const runState = await deriveWorkerRunState(worker.id);
		views.push({
			workerId: worker.id,
			displayName: worker.displayName,
			capabilities: worker.capabilities,
			runState,
			enrollments: enrollments.map(assembleOwnerEnrollmentView),
		});
	}
	return views;
}

/** The fields a caller supplies to enroll a (already-resolved) worker into a project. */
export interface EnrollWorkerInput {
	/** The resolved worker — the caller has already established ownership/existence. */
	worker: Worker;
	projectId: string;
	allowedClis: AgentCli[];
	/** Concurrency allocation for the project; defaults to 1. */
	concurrencyAllocation?: number;
	/** Initial status; defaults to `pending` (awaiting a projectAdmin's approval). */
	status?: EnrollmentStatus;
	/** Initial sharing consent; defaults to `false` (owner opts in explicitly). */
	sharingConsent?: boolean;
}

/**
 * Enroll a worker into a project. Validates `allowedClis` (non-empty,
 * de-duplicated) and enforces that it is a **subset of the worker's declared
 * capabilities** — throwing {@link AllowedClisNotCapableError} otherwise — then
 * persists a `pending` enrollment (unless a status is given) with sharing
 * consent off by default. A duplicate `(worker, project)` surfaces the
 * repository's pg `23505` for the caller to translate.
 */
export async function enrollWorker(input: EnrollWorkerInput): Promise<WorkerEnrollment> {
	const allowedClis = EnrollmentAllowedClisSchema.parse(input.allowedClis);
	assertClisWithinCapabilities(input.worker, allowedClis);
	const concurrencyAllocation = ConcurrencyAllocationSchema.parse(input.concurrencyAllocation ?? 1);
	return createEnrollment({
		workerId: input.worker.id,
		projectId: input.projectId,
		status: input.status ?? 'pending',
		allowedClis,
		concurrencyAllocation,
		sharingConsent: input.sharingConsent ?? false,
	});
}

/** Throw {@link AllowedClisNotCapableError} unless every allowed CLI is a declared capability. */
function assertClisWithinCapabilities(worker: Worker, allowedClis: AgentCli[]): void {
	const capabilitySet = new Set(worker.capabilities);
	const offending = allowedClis.filter((cli) => !capabilitySet.has(cli));
	if (offending.length > 0) {
		throw new AllowedClisNotCapableError(worker.id, offending);
	}
}

/** Resolve an enrollment by id — the read the router uses before an ownership/authz check. */
export async function getEnrollment(id: string): Promise<WorkerEnrollment | undefined> {
	return getEnrollmentById(id);
}

/**
 * Approve a `pending` enrollment → `active` (a `projectAdmin` action). Returns
 * the updated enrollment, or `undefined` if no enrollment has that id. Approval
 * alone does not make a worker routable — the owner must also grant sharing
 * consent ({@link isRoutable}).
 */
export async function approveEnrollment(id: string): Promise<WorkerEnrollment | undefined> {
	return updateEnrollmentStatus(id, 'active');
}

/**
 * Set an enrollment's status directly — `active` (approve/reactivate) or
 * `suspended` (revoke). Suspending flips `isRoutable` false, blocking future
 * dispatch, without deleting the enrollment or touching a running process.
 * Returns the updated enrollment, or `undefined` if no enrollment has that id.
 */
export async function setEnrollmentStatus(
	id: string,
	status: EnrollmentStatus,
): Promise<WorkerEnrollment | undefined> {
	return updateEnrollmentStatus(id, status);
}

/**
 * Set (or revoke) the owner-controlled sharing consent. Revoking (`false`)
 * flips `isRoutable` false without touching the worker, its session, or any
 * running process. Returns the updated enrollment, or `undefined` if no
 * enrollment has that id.
 */
export async function setSharingConsent(
	id: string,
	sharingConsent: boolean,
): Promise<WorkerEnrollment | undefined> {
	return setEnrollmentSharingConsent(id, sharingConsent);
}

/** The mutable execution constraints; each field is optional so a caller updates only what changed. */
export interface UpdateEnrollmentConstraintsInput {
	/** The resolved worker — needed to re-validate an `allowedClis` change against its capabilities. */
	worker: Worker;
	enrollmentId: string;
	allowedClis?: AgentCli[];
	concurrencyAllocation?: number;
}

/**
 * Update an enrollment's execution constraints. When `allowedClis` is given it
 * is re-validated (non-empty, de-duplicated) and re-checked against the worker's
 * capabilities; `concurrencyAllocation`, when given, must be a positive integer.
 * Returns the updated enrollment, or `undefined` if no enrollment has that id.
 */
export async function updateEnrollmentConstraints(
	input: UpdateEnrollmentConstraintsInput,
): Promise<WorkerEnrollment | undefined> {
	const patch: { allowedClis?: AgentCli[]; concurrencyAllocation?: number } = {};
	if (input.allowedClis !== undefined) {
		const allowedClis = EnrollmentAllowedClisSchema.parse(input.allowedClis);
		assertClisWithinCapabilities(input.worker, allowedClis);
		patch.allowedClis = allowedClis;
	}
	if (input.concurrencyAllocation !== undefined) {
		patch.concurrencyAllocation = ConcurrencyAllocationSchema.parse(input.concurrencyAllocation);
	}
	return updateEnrollmentConstraintsRow(input.enrollmentId, patch);
}
