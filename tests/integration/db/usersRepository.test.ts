import { beforeEach, describe, expect, it } from 'vitest';

import {
	createUser,
	findUserByIdentifier,
	getUserById,
	listUsers,
	setInstanceAdmin,
} from '../../../src/db/repositories/usersRepository.js';
import { truncateAll } from '../helpers/db.js';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('usersRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
	});

	describe('createUser', () => {
		it('creates a user with generated id/timestamps and default non-admin', async () => {
			const user = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });

			expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
			expect(user.identifier).toBe('ada@example.com');
			expect(user.displayName).toBe('Ada');
			expect(user.instanceAdmin).toBe(false);
			expect(user.createdAt).toBeInstanceOf(Date);
			expect(user.updatedAt).toBeInstanceOf(Date);
		});

		it('honours an explicit instanceAdmin flag', async () => {
			const user = await createUser({
				identifier: 'admin@example.com',
				displayName: 'Admin',
				instanceAdmin: true,
			});
			expect(user.instanceAdmin).toBe(true);
		});

		it('rejects a duplicate identifier with a unique violation', async () => {
			await createUser({ identifier: 'dup@example.com', displayName: 'First' });
			await expect(
				createUser({ identifier: 'dup@example.com', displayName: 'Second' }),
			).rejects.toMatchObject({
				cause: expect.objectContaining({ code: '23505' }),
			});
		});
	});

	describe('getUserById / findUserByIdentifier', () => {
		it('round-trips a created user by id and by identifier', async () => {
			const created = await createUser({ identifier: 'grace@example.com', displayName: 'Grace' });

			expect(await getUserById(created.id)).toEqual(created);
			expect(await findUserByIdentifier('grace@example.com')).toEqual(created);
		});

		it('returns undefined for unknown lookups', async () => {
			expect(await getUserById('11111111-1111-4111-8111-111111111111')).toBeUndefined();
			expect(await findUserByIdentifier('nobody@example.com')).toBeUndefined();
		});
	});

	describe('listUsers', () => {
		it('lists all users ordered by identifier', async () => {
			await createUser({ identifier: 'b@example.com', displayName: 'B' });
			await createUser({ identifier: 'a@example.com', displayName: 'A' });

			const identifiers = (await listUsers()).map((u) => u.identifier);
			expect(identifiers).toEqual(['a@example.com', 'b@example.com']);
		});
	});

	describe('setInstanceAdmin', () => {
		it('flips the admin flag and returns the updated user', async () => {
			const user = await createUser({ identifier: 'flip@example.com', displayName: 'Flip' });

			const granted = await setInstanceAdmin(user.id, true);
			expect(granted?.instanceAdmin).toBe(true);

			const revoked = await setInstanceAdmin(user.id, false);
			expect(revoked?.instanceAdmin).toBe(false);
		});

		it('returns undefined for an unknown id', async () => {
			expect(await setInstanceAdmin('11111111-1111-4111-8111-111111111111', true)).toBeUndefined();
		});
	});
});
