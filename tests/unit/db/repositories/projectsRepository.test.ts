import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client.js', () => ({ getDb: vi.fn() }));

import { getDb } from '@/db/client.js';
import {
	findProjectByIdFromDb,
	findProjectByRepoFromDb,
} from '@/db/repositories/projectsRepository.js';

function stubDb(rows: unknown[]): void {
	const builder = {
		select: () => builder,
		from: () => builder,
		where: () => builder,
		limit: () => Promise.resolve(rows),
	};
	vi.mocked(getDb).mockReturnValue(builder as unknown as ReturnType<typeof getDb>);
}

const row = {
	id: 'proj-1',
	name: 'swarm',
	repo: 'jkwiecien/swarm',
	repoRoot: '/Users/dev/swarm',
	worktreeRoot: '.swarm-workspaces',
	baseBranch: 'main',
	branchPrefix: 'issue-',
	pmType: 'github-projects',
	githubProjects: {
		projectId: 'PVT_x',
		statusFieldId: 'PVTSSF_x',
		statusOptions: { backlog: 'a', ready: 'b', inProgress: 'c', inReview: 'd', done: 'e' },
	},
	credentials: { implementer: 'IMPL', reviewer: 'REV', webhookSecret: 'HOOK' },
	createdAt: new Date(),
	updatedAt: new Date(),
};

describe('projectsRepository', () => {
	beforeEach(() => {
		vi.mocked(getDb).mockReset();
	});

	describe('findProjectByRepoFromDb', () => {
		it('maps a row back to a ProjectConfig', async () => {
			stubDb([row]);
			const project = await findProjectByRepoFromDb('jkwiecien/swarm');
			expect(project).toMatchObject({
				id: 'proj-1',
				repo: 'jkwiecien/swarm',
				pm: { type: 'github-projects' },
				credentials: { implementer: 'IMPL', reviewer: 'REV', webhookSecret: 'HOOK' },
			});
			// The persisted DB timestamps are not part of the config shape.
			expect(project).not.toHaveProperty('createdAt');
		});

		it('returns undefined when no project owns the repo', async () => {
			stubDb([]);
			expect(await findProjectByRepoFromDb('someone/else')).toBeUndefined();
		});
	});

	describe('findProjectByIdFromDb', () => {
		it('returns undefined for an unknown id', async () => {
			stubDb([]);
			expect(await findProjectByIdFromDb('nope')).toBeUndefined();
		});
	});
});
