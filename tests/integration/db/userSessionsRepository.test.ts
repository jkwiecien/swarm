import { beforeEach, describe, expect, it } from 'vitest';
import {
	deleteExpiredSessions,
	deleteSessionByToken,
	findUserIdBySessionToken,
	insertSession,
} from '../../../src/db/repositories/userSessionsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { truncateAll } from '../helpers/db.js';

const HOUR = 60 * 60 * 1000;

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'userSessionsRepository (integration)',
	() => {
		beforeEach(async () => {
			await truncateAll();
		});

		it('round-trips a live session by token hash', async () => {
			const user = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
			await insertSession({
				userId: user.id,
				tokenHash: 'hash-abc',
				expiresAt: new Date(Date.now() + HOUR),
			});

			expect(await findUserIdBySessionToken('hash-abc')).toBe(user.id);
			expect(await findUserIdBySessionToken('hash-unknown')).toBeUndefined();
		});

		it('does not resolve an expired session', async () => {
			const user = await createUser({ identifier: 'grace@example.com', displayName: 'Grace' });
			await insertSession({
				userId: user.id,
				tokenHash: 'hash-expired',
				expiresAt: new Date(Date.now() - HOUR),
			});

			expect(await findUserIdBySessionToken('hash-expired')).toBeUndefined();
		});

		it('deletes a session by token (logout)', async () => {
			const user = await createUser({ identifier: 'del@example.com', displayName: 'Del' });
			await insertSession({
				userId: user.id,
				tokenHash: 'hash-del',
				expiresAt: new Date(Date.now() + HOUR),
			});

			await deleteSessionByToken('hash-del');
			expect(await findUserIdBySessionToken('hash-del')).toBeUndefined();
		});

		it('sweeps only expired sessions, leaving live ones', async () => {
			const user = await createUser({ identifier: 'sweep@example.com', displayName: 'Sweep' });
			await insertSession({
				userId: user.id,
				tokenHash: 'hash-live',
				expiresAt: new Date(Date.now() + HOUR),
			});
			await insertSession({
				userId: user.id,
				tokenHash: 'hash-dead',
				expiresAt: new Date(Date.now() - HOUR),
			});

			expect(await deleteExpiredSessions()).toBe(1);
			expect(await findUserIdBySessionToken('hash-live')).toBe(user.id);
		});
	},
);
