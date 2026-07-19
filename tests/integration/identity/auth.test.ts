import { beforeEach, describe, expect, it } from 'vitest';

import { createUser, setPasswordHash } from '../../../src/db/repositories/usersRepository.js';
import {
	createSession,
	hashPassword,
	resolveSession,
	revokeSession,
	verifyCredentials,
} from '../../../src/identity/auth.js';
import { truncateAll } from '../helpers/db.js';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('session auth flow (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
	});

	it('verifies credentials against the stored hash', async () => {
		const user = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
		await setPasswordHash(user.id, await hashPassword('hunter2'));

		expect(await verifyCredentials('ada@example.com', 'hunter2')).toMatchObject({ id: user.id });
		expect(await verifyCredentials('ada@example.com', 'wrong')).toBeUndefined();
		expect(await verifyCredentials('nobody@example.com', 'hunter2')).toBeUndefined();
	});

	it('rejects a user who has no password set', async () => {
		await createUser({ identifier: 'nopass@example.com', displayName: 'No Pass' });
		expect(await verifyCredentials('nopass@example.com', 'anything')).toBeUndefined();
	});

	it('runs the login → authorized → logout lifecycle', async () => {
		const user = await createUser({ identifier: 'grace@example.com', displayName: 'Grace' });
		await setPasswordHash(user.id, await hashPassword('correct-horse'));

		// Log in: verify then mint a session.
		const verified = await verifyCredentials('grace@example.com', 'correct-horse');
		expect(verified).toBeDefined();
		const { token } = await createSession(user.id);

		// The raw token resolves back to the same user.
		expect(await resolveSession(token)).toMatchObject({ id: user.id });

		// Log out: the session no longer resolves.
		await revokeSession(token);
		expect(await resolveSession(token)).toBeUndefined();
	});
});
