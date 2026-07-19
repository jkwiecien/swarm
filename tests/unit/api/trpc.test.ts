import { describe, expect, it } from 'vitest';

import { authRouter } from '@/api/routers/auth.js';
import { createCallerFactory } from '@/api/trpc.js';
import type { SwarmUser } from '@/identity/schema.js';

// `auth.me` is the smallest real `authedProcedure`, so it doubles as the test of
// the procedure's guard: it must 401 when the context has no user and return the
// current user otherwise.
const createCaller = createCallerFactory(authRouter);

const user: SwarmUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'ada@example.com',
	displayName: 'Ada',
	instanceAdmin: true,
	createdAt: new Date('2020-01-01T00:00:00Z'),
	updatedAt: new Date('2020-01-01T00:00:00Z'),
};

describe('authedProcedure', () => {
	it('throws UNAUTHORIZED when the context has no user', async () => {
		const caller = createCaller({ user: null });
		await expect(caller.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
	});

	it('returns the current user when the context is authenticated', async () => {
		const caller = createCaller({ user });
		await expect(caller.me()).resolves.toEqual(user);
	});
});
