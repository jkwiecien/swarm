import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	createEnrollment,
	getEnrollmentById,
	listEnrollmentsForProject,
	listEnrollmentsForWorker,
	setEnrollmentSharingConsent,
	updateEnrollmentConstraintsRow,
	updateEnrollmentStatus,
} = vi.hoisted(() => ({
	createEnrollment: vi.fn(),
	getEnrollmentById: vi.fn(),
	listEnrollmentsForProject: vi.fn(),
	listEnrollmentsForWorker: vi.fn(),
	setEnrollmentSharingConsent: vi.fn(),
	updateEnrollmentConstraintsRow: vi.fn(),
	updateEnrollmentStatus: vi.fn(),
}));
const { getWorkerById, listWorkersForOwner } = vi.hoisted(() => ({
	getWorkerById: vi.fn(),
	listWorkersForOwner: vi.fn(),
}));
const { getUserById } = vi.hoisted(() => ({ getUserById: vi.fn() }));
const { getRunByIdFromDb } = vi.hoisted(() => ({ getRunByIdFromDb: vi.fn() }));
const { getLiveSessionForWorker } = vi.hoisted(() => ({ getLiveSessionForWorker: vi.fn() }));

vi.mock('@/db/repositories/workerEnrollmentsRepository.js', () => ({
	createEnrollment,
	getEnrollmentById,
	listEnrollmentsForProject,
	listEnrollmentsForWorker,
	setEnrollmentSharingConsent,
	updateEnrollmentConstraints: updateEnrollmentConstraintsRow,
	updateEnrollmentStatus,
}));
vi.mock('@/db/repositories/workersRepository.js', () => ({ getWorkerById, listWorkersForOwner }));
vi.mock('@/db/repositories/usersRepository.js', () => ({ getUserById }));
vi.mock('@/db/repositories/runsRepository.js', () => ({ getRunByIdFromDb }));
vi.mock('@/identity/worker-session-service.js', () => ({ getLiveSessionForWorker }));

import type { SwarmUser } from '@/identity/schema.js';
import type { Worker } from '@/identity/worker.js';
import type { WorkerEnrollment } from '@/identity/worker-enrollment.js';
import {
	AllowedClisNotCapableError,
	approveEnrollment,
	deriveWorkerRunState,
	enrollWorker,
	listOwnerWorkers,
	listProjectRoster,
	setSharingConsent,
	updateEnrollmentConstraints,
} from '@/identity/worker-enrollment-service.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const ENROLLMENT_ID = '44444444-4444-4444-8444-444444444444';

function makeWorker(overrides: Partial<Worker> = {}): Worker {
	return {
		id: WORKER_ID,
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude', 'codex'],
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

function makeOwner(overrides: Partial<SwarmUser> = {}): SwarmUser {
	return {
		id: OWNER_ID,
		identifier: 'ada@example.com',
		displayName: 'Ada Lovelace',
		instanceAdmin: false,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

function makeEnrollment(overrides: Partial<WorkerEnrollment> = {}): WorkerEnrollment {
	return {
		id: ENROLLMENT_ID,
		workerId: WORKER_ID,
		projectId: 'proj-a',
		status: 'active',
		allowedClis: ['claude'],
		concurrencyAllocation: 1,
		sharingConsent: true,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

beforeEach(() => {
	for (const m of [
		createEnrollment,
		getEnrollmentById,
		listEnrollmentsForProject,
		listEnrollmentsForWorker,
		setEnrollmentSharingConsent,
		updateEnrollmentConstraintsRow,
		updateEnrollmentStatus,
		getWorkerById,
		listWorkersForOwner,
		getUserById,
		getRunByIdFromDb,
		getLiveSessionForWorker,
	]) {
		m.mockReset();
	}
});

describe('deriveWorkerRunState (busy/current-run from run lifecycle)', () => {
	it('is idle when the worker has no live session', async () => {
		getLiveSessionForWorker.mockResolvedValue(undefined);
		expect(await deriveWorkerRunState(WORKER_ID)).toEqual({ busy: false, currentRunId: null });
		expect(getRunByIdFromDb).not.toHaveBeenCalled();
	});

	it('is idle when the live session has no current run', async () => {
		getLiveSessionForWorker.mockResolvedValue({ currentRunId: null });
		expect(await deriveWorkerRunState(WORKER_ID)).toEqual({ busy: false, currentRunId: null });
		expect(getRunByIdFromDb).not.toHaveBeenCalled();
	});

	it('is busy when the live session points at a running run', async () => {
		getLiveSessionForWorker.mockResolvedValue({ currentRunId: RUN_ID });
		getRunByIdFromDb.mockResolvedValue({ id: RUN_ID, status: 'running' });
		expect(await deriveWorkerRunState(WORKER_ID)).toEqual({ busy: true, currentRunId: RUN_ID });
	});

	it('is idle when the pointed-at run is no longer running (stale pointer)', async () => {
		getLiveSessionForWorker.mockResolvedValue({ currentRunId: RUN_ID });
		getRunByIdFromDb.mockResolvedValue({ id: RUN_ID, status: 'completed' });
		expect(await deriveWorkerRunState(WORKER_ID)).toEqual({ busy: false, currentRunId: null });
	});

	it('is idle when the pointed-at run no longer exists', async () => {
		getLiveSessionForWorker.mockResolvedValue({ currentRunId: RUN_ID });
		getRunByIdFromDb.mockResolvedValue(undefined);
		expect(await deriveWorkerRunState(WORKER_ID)).toEqual({ busy: false, currentRunId: null });
	});
});

describe('listProjectRoster', () => {
	it('assembles a secret-free entry with owner, capabilities, constraints, isRoutable and run state', async () => {
		listEnrollmentsForProject.mockResolvedValue([
			makeEnrollment({ status: 'active', sharingConsent: true }),
		]);
		getWorkerById.mockResolvedValue(makeWorker());
		getUserById.mockResolvedValue(makeOwner());
		getLiveSessionForWorker.mockResolvedValue({ currentRunId: RUN_ID });
		getRunByIdFromDb.mockResolvedValue({ id: RUN_ID, status: 'running' });

		const [entry] = await listProjectRoster('proj-a');

		// Exactly the intended fields — no repo path, PAT, token, or credential hash
		// can ride along, because the assembler names each field explicitly.
		expect(Object.keys(entry).sort()).toEqual(
			[
				'allowedClis',
				'capabilities',
				'concurrencyAllocation',
				'displayName',
				'enrollmentId',
				'isRoutable',
				'owner',
				'projectId',
				'runState',
				'sharingConsent',
				'status',
				'workerId',
			].sort(),
		);
		expect(Object.keys(entry.owner ?? {}).sort()).toEqual(['displayName', 'identifier', 'userId']);
		expect(entry).toMatchObject({
			workerId: WORKER_ID,
			displayName: 'ada-laptop',
			capabilities: ['claude', 'codex'],
			status: 'active',
			allowedClis: ['claude'],
			sharingConsent: true,
			isRoutable: true,
			runState: { busy: true, currentRunId: RUN_ID },
		});
		expect(JSON.stringify(entry)).not.toMatch(/credential|password|token|repoRoot|worktree/i);
	});

	it('reports isRoutable false for a consent-revoked enrollment', async () => {
		listEnrollmentsForProject.mockResolvedValue([
			makeEnrollment({ status: 'active', sharingConsent: false }),
		]);
		getWorkerById.mockResolvedValue(makeWorker());
		getUserById.mockResolvedValue(makeOwner());
		getLiveSessionForWorker.mockResolvedValue(undefined);

		const [entry] = await listProjectRoster('proj-a');
		expect(entry.isRoutable).toBe(false);
	});

	it('skips an enrollment whose worker has vanished', async () => {
		listEnrollmentsForProject.mockResolvedValue([makeEnrollment()]);
		getWorkerById.mockResolvedValue(undefined);

		expect(await listProjectRoster('proj-a')).toEqual([]);
	});
});

describe('listOwnerWorkers', () => {
	it('returns only the owner’s own workers, each with its enrollments and run state', async () => {
		listWorkersForOwner.mockResolvedValue([makeWorker()]);
		listEnrollmentsForWorker.mockResolvedValue([
			makeEnrollment({ projectId: 'proj-a' }),
			makeEnrollment({ id: 'e2', projectId: 'proj-b', status: 'pending', sharingConsent: false }),
		]);
		getLiveSessionForWorker.mockResolvedValue(undefined);

		const views = await listOwnerWorkers(OWNER_ID);

		expect(listWorkersForOwner).toHaveBeenCalledWith(OWNER_ID);
		expect(views).toHaveLength(1);
		expect(views[0]).toMatchObject({
			workerId: WORKER_ID,
			displayName: 'ada-laptop',
			runState: { busy: false, currentRunId: null },
		});
		expect(views[0].enrollments.map((e) => e.projectId)).toEqual(['proj-a', 'proj-b']);
		// The owner view carries no owner/worker secret and no derived-from-elsewhere leaks.
		expect(JSON.stringify(views)).not.toMatch(/credential|password|token|repoRoot/i);
	});

	it('returns nothing for an owner with no workers', async () => {
		listWorkersForOwner.mockResolvedValue([]);
		expect(await listOwnerWorkers(OWNER_ID)).toEqual([]);
	});
});

describe('enrollWorker', () => {
	it('rejects allowed CLIs that exceed the worker’s capabilities', async () => {
		const worker = makeWorker({ capabilities: ['claude'] });

		await expect(
			enrollWorker({ worker, projectId: 'proj-a', allowedClis: ['claude', 'codex'] }),
		).rejects.toBeInstanceOf(AllowedClisNotCapableError);
		expect(createEnrollment).not.toHaveBeenCalled();
	});

	it('de-dupes allowed CLIs, defaults status pending / consent off / concurrency 1', async () => {
		const worker = makeWorker({ capabilities: ['claude', 'codex'] });
		createEnrollment.mockImplementation(async (input) => makeEnrollment(input));

		await enrollWorker({ worker, projectId: 'proj-a', allowedClis: ['claude', 'claude'] });

		expect(createEnrollment).toHaveBeenCalledWith({
			workerId: WORKER_ID,
			projectId: 'proj-a',
			status: 'pending',
			allowedClis: ['claude'],
			concurrencyAllocation: 1,
			sharingConsent: false,
		});
	});

	it('passes through an explicit status, consent, and concurrency', async () => {
		const worker = makeWorker();
		createEnrollment.mockImplementation(async (input) => makeEnrollment(input));

		await enrollWorker({
			worker,
			projectId: 'proj-a',
			allowedClis: ['claude'],
			concurrencyAllocation: 4,
			status: 'active',
			sharingConsent: true,
		});

		expect(createEnrollment).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'active', sharingConsent: true, concurrencyAllocation: 4 }),
		);
	});

	it('rejects a non-positive concurrency allocation', async () => {
		const worker = makeWorker();
		await expect(
			enrollWorker({
				worker,
				projectId: 'proj-a',
				allowedClis: ['claude'],
				concurrencyAllocation: 0,
			}),
		).rejects.toThrow();
		expect(createEnrollment).not.toHaveBeenCalled();
	});
});

describe('updateEnrollmentConstraints', () => {
	it('re-validates an allowedClis change against the worker’s capabilities', async () => {
		const worker = makeWorker({ capabilities: ['claude'] });
		await expect(
			updateEnrollmentConstraints({ worker, enrollmentId: ENROLLMENT_ID, allowedClis: ['codex'] }),
		).rejects.toBeInstanceOf(AllowedClisNotCapableError);
		expect(updateEnrollmentConstraintsRow).not.toHaveBeenCalled();
	});

	it('passes a validated patch through to the repository', async () => {
		const worker = makeWorker({ capabilities: ['claude', 'codex'] });
		updateEnrollmentConstraintsRow.mockResolvedValue(makeEnrollment());

		await updateEnrollmentConstraints({
			worker,
			enrollmentId: ENROLLMENT_ID,
			allowedClis: ['codex', 'codex'],
			concurrencyAllocation: 3,
		});

		expect(updateEnrollmentConstraintsRow).toHaveBeenCalledWith(ENROLLMENT_ID, {
			allowedClis: ['codex'],
			concurrencyAllocation: 3,
		});
	});
});

describe('status / consent write delegation', () => {
	it('approveEnrollment sets the status active', async () => {
		updateEnrollmentStatus.mockResolvedValue(makeEnrollment({ status: 'active' }));
		await approveEnrollment(ENROLLMENT_ID);
		expect(updateEnrollmentStatus).toHaveBeenCalledWith(ENROLLMENT_ID, 'active');
	});

	it('setSharingConsent delegates the boolean to the repository', async () => {
		setEnrollmentSharingConsent.mockResolvedValue(makeEnrollment({ sharingConsent: false }));
		await setSharingConsent(ENROLLMENT_ID, false);
		expect(setEnrollmentSharingConsent).toHaveBeenCalledWith(ENROLLMENT_ID, false);
	});
});
