import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import {
	createWorker,
	findWorkerByCredentialHash,
	getWorkerById,
	listWorkersForOwner,
	removeWorker,
	updateWorkerCapabilities,
} from '../../../src/db/repositories/workersRepository.js';
import { users } from '../../../src/db/schema/users.js';
import { truncateAll } from '../helpers/db.js';

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
