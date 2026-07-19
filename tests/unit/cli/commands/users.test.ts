import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createUser, findUserByIdentifier, listUsers, setInstanceAdmin, closeDb } = vi.hoisted(
	() => ({
		createUser: vi.fn(),
		findUserByIdentifier: vi.fn(),
		listUsers: vi.fn(),
		setInstanceAdmin: vi.fn(),
		closeDb: vi.fn(),
	}),
);

vi.mock('@/db/repositories/usersRepository.js', () => ({
	createUser,
	findUserByIdentifier,
	listUsers,
	setInstanceAdmin,
}));
vi.mock('@/db/client.js', () => ({ closeDb }));

import { run } from '@/cli/commands/users.js';

function makeUser(overrides: Record<string, unknown> = {}) {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		identifier: 'ada@example.com',
		displayName: 'Ada Lovelace',
		instanceAdmin: false,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

describe('swarm users', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		createUser.mockReset().mockImplementation(async (input) => makeUser(input));
		findUserByIdentifier.mockReset().mockResolvedValue(makeUser());
		listUsers.mockReset().mockResolvedValue([]);
		setInstanceAdmin
			.mockReset()
			.mockImplementation(async (_id, value) => makeUser({ instanceAdmin: value }));
		closeDb.mockReset().mockResolvedValue(undefined);
	});

	describe('add', () => {
		it('creates a user with an inferred display name and closes the db', async () => {
			expect(await run(['add', 'ada@example.com'])).toBe(0);
			expect(createUser).toHaveBeenCalledWith({
				identifier: 'ada@example.com',
				displayName: 'ada@example.com',
				instanceAdmin: false,
			});
			expect(closeDb).toHaveBeenCalledOnce();
		});

		it('honours --name and --admin', async () => {
			expect(await run(['add', 'ada@example.com', '--name', 'Ada', '--admin'])).toBe(0);
			expect(createUser).toHaveBeenCalledWith({
				identifier: 'ada@example.com',
				displayName: 'Ada',
				instanceAdmin: true,
			});
		});

		it('requires an identifier', async () => {
			expect(await run(['add'])).toBe(1);
			expect(createUser).not.toHaveBeenCalled();
		});

		it('translates a duplicate identifier to a friendly error', async () => {
			createUser.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
			const error = vi.spyOn(console, 'error');
			expect(await run(['add', 'ada@example.com'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
			expect(closeDb).toHaveBeenCalledOnce();
		});
	});

	describe('list', () => {
		it('lists users and closes the db', async () => {
			listUsers.mockResolvedValue([makeUser(), makeUser({ instanceAdmin: true })]);
			expect(await run(['list'])).toBe(0);
			expect(listUsers).toHaveBeenCalledOnce();
			expect(closeDb).toHaveBeenCalledOnce();
		});
	});

	describe('grant-admin / revoke-admin', () => {
		it('grants admin to an existing user', async () => {
			expect(await run(['grant-admin', 'ada@example.com'])).toBe(0);
			expect(setInstanceAdmin).toHaveBeenCalledWith(expect.any(String), true);
		});

		it('revokes admin from an existing user', async () => {
			expect(await run(['revoke-admin', 'ada@example.com'])).toBe(0);
			expect(setInstanceAdmin).toHaveBeenCalledWith(expect.any(String), false);
		});

		it('fails for an unknown identifier without mutating', async () => {
			findUserByIdentifier.mockResolvedValue(undefined);
			expect(await run(['grant-admin', 'nobody'])).toBe(1);
			expect(setInstanceAdmin).not.toHaveBeenCalled();
		});
	});

	describe('dispatch', () => {
		it('returns 1 for an unknown subcommand without opening the db', async () => {
			expect(await run(['nope'])).toBe(1);
			expect(closeDb).not.toHaveBeenCalled();
		});

		it('returns 1 with no subcommand and 0 for explicit --help', async () => {
			expect(await run([])).toBe(1);
			expect(await run(['--help'])).toBe(0);
			expect(createUser).not.toHaveBeenCalled();
			expect(closeDb).not.toHaveBeenCalled();
		});
	});
});
