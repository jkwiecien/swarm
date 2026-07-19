import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMembership, listMembersForProject, listProjectsForUser } = vi.hoisted(() => ({
	getMembership: vi.fn(),
	listMembersForProject: vi.fn(),
	listProjectsForUser: vi.fn(),
}));
const { listAllProjectsFromDb } = vi.hoisted(() => ({ listAllProjectsFromDb: vi.fn() }));
const { isInstanceAdmin } = vi.hoisted(() => ({ isInstanceAdmin: vi.fn() }));

vi.mock('@/db/repositories/projectMembersRepository.js', () => ({
	getMembership,
	listMembersForProject,
	listProjectsForUser,
}));
vi.mock('@/db/repositories/projectsRepository.js', () => ({ listAllProjectsFromDb }));
vi.mock('@/identity/service.js', () => ({ isInstanceAdmin }));

import type { ProjectMembership } from '@/identity/membership.js';
import * as service from '@/identity/membership-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function membership(overrides: Partial<ProjectMembership> = {}): ProjectMembership {
	return {
		id: '99999999-9999-4999-8999-999999999999',
		projectId: 'proj-alpha',
		userId: USER_ID,
		role: 'member',
		createdAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

describe('membership service', () => {
	beforeEach(() => {
		getMembership.mockReset();
		listMembersForProject.mockReset();
		listProjectsForUser.mockReset();
		listAllProjectsFromDb.mockReset();
		isInstanceAdmin.mockReset();
	});

	describe('read pass-throughs', () => {
		it('delegates getMembership / listMembersForProject / listProjectsForUser to the repository', async () => {
			const m = membership();
			getMembership.mockResolvedValue(m);
			listMembersForProject.mockResolvedValue([m]);
			listProjectsForUser.mockResolvedValue([m]);

			expect(await service.getMembership(USER_ID, 'proj-alpha')).toBe(m);
			expect(getMembership).toHaveBeenCalledWith(USER_ID, 'proj-alpha');
			expect(await service.listMembersForProject('proj-alpha')).toEqual([m]);
			expect(listMembersForProject).toHaveBeenCalledWith('proj-alpha');
			expect(await service.listProjectsForUser(USER_ID)).toEqual([m]);
			expect(listProjectsForUser).toHaveBeenCalledWith(USER_ID);
		});
	});

	describe('listAccessibleProjectIds', () => {
		it('returns every project id (sorted) for an installation admin, ignoring membership', async () => {
			isInstanceAdmin.mockResolvedValue(true);
			listAllProjectsFromDb.mockResolvedValue([{ id: 'proj-b' }, { id: 'proj-a' }]);

			expect(await service.listAccessibleProjectIds(USER_ID)).toEqual(['proj-a', 'proj-b']);
			expect(isInstanceAdmin).toHaveBeenCalledWith(USER_ID);
			expect(listProjectsForUser).not.toHaveBeenCalled();
		});

		it('returns only the membership set (sorted, de-duplicated) for a non-admin', async () => {
			isInstanceAdmin.mockResolvedValue(false);
			listProjectsForUser.mockResolvedValue([
				membership({ projectId: 'proj-z' }),
				membership({ projectId: 'proj-a' }),
			]);

			expect(await service.listAccessibleProjectIds(USER_ID)).toEqual(['proj-a', 'proj-z']);
			expect(listProjectsForUser).toHaveBeenCalledWith(USER_ID);
			expect(listAllProjectsFromDb).not.toHaveBeenCalled();
		});

		it('returns an empty set for a non-admin with no memberships', async () => {
			isInstanceAdmin.mockResolvedValue(false);
			listProjectsForUser.mockResolvedValue([]);

			expect(await service.listAccessibleProjectIds(USER_ID)).toEqual([]);
		});
	});
});
