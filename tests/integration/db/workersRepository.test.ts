import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { createEnrollment } from '../../../src/db/repositories/workerEnrollmentsRepository.js';
import {
	createWorker,
	findWorkerByCredentialHash,
	getWorkerById,
	listWorkersForOwner,
	removeWorker,
	updateWorkerCapabilities,
} from '../../../src/db/repositories/workersRepository.js';
import { users } from '../../../src/db/schema/users.js';
import { workerProjectEnrollments } from '../../../src/db/schema/workerProjectEnrollments.js';
import type { AgentCli } from '../../../src/harness/agent-cli.js';
import { WorkerCapabilityReductionError } from '../../../src/identity/worker.js';
import { AllowedClisNotCapableError } from '../../../src/identity/worker-enrollment.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('workersRepository (integration)', () => {
	let adaId: string;
	let graceId: string;

	beforeEach(async () => {
		await truncateAll();
		adaId = (await createUser({ identifier: 'ada@example.com', displayName: 'Ada' })).id;
		graceId = (await createUser({ identifier: 'grace@example.com', displayName: 'Grace' })).id;
	});

	describe('createWorker / getWorkerById', () => {
		it('round-trips a created worker with generated id/timestamps and no credential hash', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude', 'codex'],
				credentialHash: 'hash-a',
			});

			expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
			expect(created.ownerUserId).toBe(adaId);
			expect(created.displayName).toBe('ada-laptop');
			expect(created.capabilities).toEqual(['claude', 'codex']);
			expect(created.createdAt).toBeInstanceOf(Date);
			expect(created.updatedAt).toBeInstanceOf(Date);
			// The credential hash never enters the domain read model.
			expect(created).not.toHaveProperty('credentialHash');

			expect(await getWorkerById(created.id)).toEqual(created);
		});

		it('returns undefined for an unknown id', async () => {
			expect(await getWorkerById('00000000-0000-4000-8000-000000000000')).toBeUndefined();
		});
	});

	describe('unique constraints', () => {
		it('rejects a duplicate (owner, displayName) with a unique violation', async () => {
			await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			await expect(
				createWorker({
					ownerUserId: adaId,
					displayName: 'ada-laptop',
					capabilities: ['codex'],
					credentialHash: 'hash-b',
				}),
			).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23505' }) });
		});

		it('allows a different owner to reuse the same display name', async () => {
			await createWorker({
				ownerUserId: adaId,
				displayName: 'shared-name',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			const graces = await createWorker({
				ownerUserId: graceId,
				displayName: 'shared-name',
				capabilities: ['codex'],
				credentialHash: 'hash-b',
			});
			expect(graces.ownerUserId).toBe(graceId);
		});

		it('rejects a duplicate credential hash with a unique violation', async () => {
			await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'shared-hash',
			});
			await expect(
				createWorker({
					ownerUserId: graceId,
					displayName: 'grace-laptop',
					capabilities: ['codex'],
					credentialHash: 'shared-hash',
				}),
			).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23505' }) });
		});
	});

	describe('findWorkerByCredentialHash', () => {
		it('resolves a worker by its credential hash and returns undefined for an unknown hash', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			expect(await findWorkerByCredentialHash('hash-a')).toEqual(created);
			expect(await findWorkerByCredentialHash('unknown-hash')).toBeUndefined();
		});
	});

	describe('updateWorkerCapabilities', () => {
		it('changes the capability set', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			const updated = await updateWorkerCapabilities(created.id, ['antigravity', 'codex']);
			expect(updated?.capabilities).toEqual(['antigravity', 'codex']);
			expect((await getWorkerById(created.id))?.capabilities).toEqual(['antigravity', 'codex']);
		});

		it('returns undefined for a missing id', async () => {
			expect(
				await updateWorkerCapabilities('00000000-0000-4000-8000-000000000000', ['claude']),
			).toBeUndefined();
		});

		it('rejects a capability reduction when an enrollment requires a CLI being removed', async () => {
			await seedProject({ id: 'proj-repo-test', repo: 'jkwiecien/repo-test' });
			const worker = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-multi-cli',
				capabilities: ['claude', 'codex'],
				credentialHash: 'hash-multi',
			});
			await createEnrollment({
				workerId: worker.id,
				projectId: 'proj-repo-test',
				status: 'active',
				allowedClis: ['claude'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});

			await expect(updateWorkerCapabilities(worker.id, ['codex'])).rejects.toThrow(
				WorkerCapabilityReductionError,
			);

			// Worker capabilities remain unchanged
			const rechecked = await getWorkerById(worker.id);
			expect(rechecked?.capabilities).toEqual(['claude', 'codex']);
		});

		it('allows capability expansion and compatible reductions when existing enrollments remain subsets', async () => {
			await seedProject({ id: 'proj-compat-test', repo: 'jkwiecien/compat-test' });
			const worker = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-compat',
				capabilities: ['claude', 'codex', 'antigravity'],
				credentialHash: 'hash-compat',
			});
			await createEnrollment({
				workerId: worker.id,
				projectId: 'proj-compat-test',
				status: 'active',
				allowedClis: ['claude'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});

			// Compatible reduction: removing 'antigravity' (not required by enrollment)
			const reduced = await updateWorkerCapabilities(worker.id, ['claude', 'codex']);
			expect(reduced?.capabilities).toEqual(['claude', 'codex']);

			// Expansion: adding 'antigravity' back
			const expanded = await updateWorkerCapabilities(worker.id, [
				'claude',
				'codex',
				'antigravity',
			]);
			expect(expanded?.capabilities).toEqual(['claude', 'codex', 'antigravity']);
		});

		it('serializes capability reduction against concurrent enrollment creation without breaking the invariant', async () => {
			await seedProject({ id: 'proj-race-test', repo: 'jkwiecien/race-test' });
			const worker = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-race',
				capabilities: ['claude', 'codex'],
				credentialHash: 'hash-race',
			});

			const [enrollRes, capRes] = await Promise.allSettled([
				createEnrollment({
					workerId: worker.id,
					projectId: 'proj-race-test',
					status: 'active',
					allowedClis: ['codex'],
					concurrencyAllocation: 1,
					sharingConsent: true,
				}),
				updateWorkerCapabilities(worker.id, ['claude']),
			]);

			// One transaction must succeed and one must be rejected
			const succeeded = [enrollRes, capRes].filter((r) => r.status === 'fulfilled');
			const rejected = [enrollRes, capRes].filter((r) => r.status === 'rejected');

			expect(succeeded).toHaveLength(1);
			expect(rejected).toHaveLength(1);

			if (capRes.status === 'fulfilled') {
				// Capability reduction to ['claude'] won, enrollment with ['codex'] was rejected
				expect(enrollRes.status).toBe('rejected');
				expect((enrollRes as PromiseRejectedResult).reason).toBeInstanceOf(
					AllowedClisNotCapableError,
				);
			} else {
				// Enrollment with ['codex'] won, capability reduction to ['claude'] was rejected
				expect(capRes.status === 'rejected').toBe(true);
				expect((capRes as PromiseRejectedResult).reason).toBeInstanceOf(
					WorkerCapabilityReductionError,
				);
			}

			// Verify invariant holds in database: active enrollment's allowedClis is a subset of worker capabilities
			const finalWorker = await getWorkerById(worker.id);
			const enrollments = await getDb()
				.select()
				.from(workerProjectEnrollments)
				.where(eq(workerProjectEnrollments.workerId, worker.id));

			const workerCapSet = new Set(finalWorker?.capabilities ?? []);
			for (const enrollment of enrollments) {
				for (const cli of enrollment.allowedClis as AgentCli[]) {
					expect(workerCapSet.has(cli)).toBe(true);
				}
			}
		});
	});

	describe('removeWorker', () => {
		it('removes a worker and reports whether one existed', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			expect(await removeWorker(created.id)).toBe(true);
			expect(await getWorkerById(created.id)).toBeUndefined();
			expect(await removeWorker(created.id)).toBe(false);
		});
	});

	describe('listWorkersForOwner', () => {
		it("returns only that owner's workers, oldest first", async () => {
			const first = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			const second = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-desktop',
				capabilities: ['codex'],
				credentialHash: 'hash-b',
			});
			await createWorker({
				ownerUserId: graceId,
				displayName: 'grace-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-c',
			});

			const adas = await listWorkersForOwner(adaId);
			expect(adas.map((w) => w.id)).toEqual([first.id, second.id]);
			expect(await listWorkersForOwner(graceId)).toHaveLength(1);
		});

		it('returns an empty array for an owner with no workers', async () => {
			expect(await listWorkersForOwner(adaId)).toEqual([]);
		});
	});

	describe('cascade deletes', () => {
		it('drops a worker when its owner is deleted', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});

			await getDb().delete(users).where(eq(users.id, adaId));

			expect(await getWorkerById(created.id)).toBeUndefined();
		});
	});
});
