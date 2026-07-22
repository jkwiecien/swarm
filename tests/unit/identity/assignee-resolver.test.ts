import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUserIdByIdentity } = vi.hoisted(() => ({ findUserIdByIdentity: vi.fn() }));
const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));

vi.mock('@/db/repositories/userIdentitiesRepository.js', () => ({ findUserIdByIdentity }));
vi.mock('@/identity/service.js', () => ({ getUser }));

import { resolveAssignedUser, resolveUserForAssignee } from '@/identity/assignee-resolver.js';
import type { SwarmUser } from '@/identity/schema.js';
import { createMockWorkItem } from '../../helpers/factories.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const ADA: SwarmUser = {
	id: USER_ID,
	identifier: 'ada@example.com',
	displayName: 'Ada Lovelace',
	instanceAdmin: false,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('assignee resolver', () => {
	beforeEach(() => {
		findUserIdByIdentity.mockReset();
		getUser.mockReset();
	});

	describe('resolveUserForAssignee', () => {
		it("resolves a linked handle to its SWARM user, keyed by the caller's provider", async () => {
			findUserIdByIdentity.mockResolvedValue(USER_ID);
			getUser.mockResolvedValue(ADA);

			await expect(resolveUserForAssignee({ handle: 'ada' }, 'github-projects')).resolves.toEqual(
				ADA,
			);
			expect(findUserIdByIdentity).toHaveBeenCalledWith('github-projects', 'ada');
		});

		it('returns undefined for an unlinked handle without loading a user', async () => {
			findUserIdByIdentity.mockResolvedValue(undefined);

			await expect(
				resolveUserForAssignee({ handle: 'stranger' }, 'github-projects'),
			).resolves.toBeUndefined();
			expect(getUser).not.toHaveBeenCalled();
		});

		it('returns undefined when the link points at a user that no longer exists', async () => {
			findUserIdByIdentity.mockResolvedValue(USER_ID);
			getUser.mockResolvedValue(undefined);

			await expect(
				resolveUserForAssignee({ handle: 'ada' }, 'github-projects'),
			).resolves.toBeUndefined();
		});

		it('does not resolve a handle linked under a different provider', async () => {
			// The repository is keyed on (provider, handle); a mismatch is a plain miss.
			findUserIdByIdentity.mockImplementation(async (provider: string) =>
				provider === 'github-projects' ? USER_ID : undefined,
			);
			getUser.mockResolvedValue(ADA);

			await expect(resolveUserForAssignee({ handle: 'ada' }, 'jira')).resolves.toBeUndefined();
		});
	});

	describe('resolveAssignedUser', () => {
		it('returns the first assignee that maps to a SWARM user, with that assignee', async () => {
			const workItem = createMockWorkItem({
				assignees: [{ handle: 'stranger' }, { handle: 'ada', displayName: 'Ada Lovelace' }],
			});
			findUserIdByIdentity.mockImplementation(async (_p: string, handle: string) =>
				handle === 'ada' ? USER_ID : undefined,
			);
			getUser.mockResolvedValue(ADA);

			await expect(resolveAssignedUser(workItem, 'github-projects')).resolves.toEqual({
				user: ADA,
				assignee: { handle: 'ada', displayName: 'Ada Lovelace' },
			});
		});

		it('returns undefined for an unassigned item without querying at all', async () => {
			await expect(
				resolveAssignedUser(createMockWorkItem(), 'github-projects'),
			).resolves.toBeUndefined();
			expect(findUserIdByIdentity).not.toHaveBeenCalled();
		});

		it('returns undefined when no assignee is linked', async () => {
			const workItem = createMockWorkItem({
				assignees: [{ handle: 'stranger' }, { handle: 'other' }],
			});
			findUserIdByIdentity.mockResolvedValue(undefined);

			await expect(resolveAssignedUser(workItem, 'github-projects')).resolves.toBeUndefined();
			expect(findUserIdByIdentity).toHaveBeenCalledTimes(2);
		});
	});
});
