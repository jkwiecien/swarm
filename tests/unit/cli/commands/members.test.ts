import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMember, listMembersForProject, updateMemberRole, removeMember } = vi.hoisted(() => ({
	addMember: vi.fn(),
	listMembersForProject: vi.fn(),
	updateMemberRole: vi.fn(),
	removeMember: vi.fn(),
}));
const { findUserByIdentifier, getUserById } = vi.hoisted(() => ({
	findUserByIdentifier: vi.fn(),
	getUserById: vi.fn(),
}));
const { findProjectByIdFromDb } = vi.hoisted(() => ({ findProjectByIdFromDb: vi.fn() }));
const { closeDb } = vi.hoisted(() => ({ closeDb: vi.fn() }));

vi.mock('@/db/repositories/projectMembersRepository.js', () => ({
	addMember,
	listMembersForProject,
	updateMemberRole,
	removeMember,
}));
vi.mock('@/db/repositories/usersRepository.js', () => ({ findUserByIdentifier, getUserById }));
vi.mock('@/db/repositories/projectsRepository.js', () => ({ findProjectByIdFromDb }));
vi.mock('@/db/client.js', () => ({ closeDb }));

import { run } from '@/cli/commands/members.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function makeUser(overrides: Record<string, unknown> = {}) {
	return {
		id: USER_ID,
		identifier: 'ada@example.com',
		displayName: 'Ada Lovelace',
		instanceAdmin: false,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function makeMembership(overrides: Record<string, unknown> = {}) {
	return {
		id: '99999999-9999-4999-8999-999999999999',
		projectId: 'proj-alpha',
		userId: USER_ID,
		role: 'member',
		createdAt: new Date(),
		...overrides,
	};
}

describe('swarm members', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		addMember.mockReset().mockImplementation(async (input) => makeMembership(input));
		listMembersForProject.mockReset().mockResolvedValue([]);
		updateMemberRole
			.mockReset()
			.mockImplementation(async (_u, _p, role) => makeMembership({ role }));
		removeMember.mockReset().mockResolvedValue(true);
		findUserByIdentifier.mockReset().mockResolvedValue(makeUser());
		getUserById.mockReset().mockResolvedValue(makeUser());
		findProjectByIdFromDb.mockReset().mockResolvedValue({ id: 'proj-alpha' });
		closeDb.mockReset().mockResolvedValue(undefined);
	});

	describe('add', () => {
		it('adds a member with the default role and closes the db', async () => {
			expect(await run(['add', 'proj-alpha', 'ada@example.com'])).toBe(0);
			expect(addMember).toHaveBeenCalledWith({
				projectId: 'proj-alpha',
				userId: USER_ID,
				role: 'member',
			});
			expect(closeDb).toHaveBeenCalledOnce();
		});

		it('honours --role', async () => {
			expect(await run(['add', 'proj-alpha', 'ada@example.com', '--role', 'projectAdmin'])).toBe(0);
			expect(addMember).toHaveBeenCalledWith({
				projectId: 'proj-alpha',
				userId: USER_ID,
				role: 'projectAdmin',
			});
		});

		it('rejects an invalid role without hitting the repository', async () => {
			expect(await run(['add', 'proj-alpha', 'ada@example.com', '--role', 'owner'])).toBe(1);
			expect(addMember).not.toHaveBeenCalled();
		});

		it('requires both a project id and a user identifier', async () => {
			expect(await run(['add', 'proj-alpha'])).toBe(1);
			expect(addMember).not.toHaveBeenCalled();
		});

		it('fails for an unknown project without resolving a user', async () => {
			findProjectByIdFromDb.mockResolvedValue(undefined);
			expect(await run(['add', 'ghost', 'ada@example.com'])).toBe(1);
			expect(findUserByIdentifier).not.toHaveBeenCalled();
			expect(addMember).not.toHaveBeenCalled();
		});

		it('fails for an unknown user', async () => {
			findUserByIdentifier.mockResolvedValue(undefined);
			expect(await run(['add', 'proj-alpha', 'nobody'])).toBe(1);
			expect(addMember).not.toHaveBeenCalled();
		});

		it('translates a duplicate membership to a friendly error', async () => {
			addMember.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
			const error = vi.spyOn(console, 'error');
			expect(await run(['add', 'proj-alpha', 'ada@example.com'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('already a member'));
			expect(closeDb).toHaveBeenCalledOnce();
		});
	});

	describe('list', () => {
		it('lists members, resolving each identifier, and closes the db', async () => {
			listMembersForProject.mockResolvedValue([makeMembership({ role: 'projectAdmin' })]);
			const log = vi.spyOn(console, 'log');
			expect(await run(['list', 'proj-alpha'])).toBe(0);
			expect(listMembersForProject).toHaveBeenCalledWith('proj-alpha');
			expect(log).toHaveBeenCalledWith(expect.stringContaining('ada@example.com'));
			expect(closeDb).toHaveBeenCalledOnce();
		});

		it('requires a project id', async () => {
			expect(await run(['list'])).toBe(1);
			expect(listMembersForProject).not.toHaveBeenCalled();
		});
	});

	describe('set-role', () => {
		it('changes an existing member role', async () => {
			expect(
				await run(['set-role', 'proj-alpha', 'ada@example.com', '--role', 'contributor']),
			).toBe(0);
			expect(updateMemberRole).toHaveBeenCalledWith(USER_ID, 'proj-alpha', 'contributor');
		});

		it('requires --role', async () => {
			expect(await run(['set-role', 'proj-alpha', 'ada@example.com'])).toBe(1);
			expect(updateMemberRole).not.toHaveBeenCalled();
		});

		it('fails when the user is not a member', async () => {
			updateMemberRole.mockResolvedValue(undefined);
			expect(await run(['set-role', 'proj-alpha', 'ada@example.com', '--role', 'member'])).toBe(1);
		});
	});

	describe('remove', () => {
		it('removes a member', async () => {
			expect(await run(['remove', 'proj-alpha', 'ada@example.com'])).toBe(0);
			expect(removeMember).toHaveBeenCalledWith(USER_ID, 'proj-alpha');
		});

		it('fails when the user is not a member', async () => {
			removeMember.mockResolvedValue(false);
			expect(await run(['remove', 'proj-alpha', 'ada@example.com'])).toBe(1);
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
			expect(addMember).not.toHaveBeenCalled();
			expect(closeDb).not.toHaveBeenCalled();
		});
	});
});
