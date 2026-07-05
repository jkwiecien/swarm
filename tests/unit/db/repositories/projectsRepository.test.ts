import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client.js', () => ({ getDb: vi.fn() }));

import { getDb } from '@/db/client.js';
import {
	findProjectByBoardFromDb,
	findProjectByIdFromDb,
	findProjectByRepoFromDb,
	upsertProjectToDb,
} from '@/db/repositories/projectsRepository.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

function stubDb(rows: unknown[]): void {
	const builder = {
		select: () => builder,
		from: () => builder,
		where: () => builder,
		limit: () => Promise.resolve(rows),
	};
	vi.mocked(getDb).mockReturnValue(builder as unknown as ReturnType<typeof getDb>);
}

/** Capture the `.values()` / `.onConflictDoUpdate()` args of an insert-upsert chain. */
function stubInsert(): {
	values: ReturnType<typeof vi.fn>;
	onConflictDoUpdate: ReturnType<typeof vi.fn>;
} {
	const onConflictDoUpdate = vi.fn(() => Promise.resolve());
	const values = vi.fn(() => ({ onConflictDoUpdate }));
	const insert = vi.fn(() => ({ values }));
	vi.mocked(getDb).mockReturnValue({ insert } as unknown as ReturnType<typeof getDb>);
	return { values, onConflictDoUpdate };
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
		statusOptions: { backlog: 'a', planning: 'b', inProgress: 'c', inReview: 'd', done: 'e' },
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

	describe('findProjectByBoardFromDb', () => {
		it('maps a row back to a ProjectConfig', async () => {
			stubDb([row]);
			const project = await findProjectByBoardFromDb('PVT_x');
			expect(project).toMatchObject({
				id: 'proj-1',
				githubProjects: { projectId: 'PVT_x' },
			});
		});

		it('returns undefined when no project owns the board', async () => {
			stubDb([]);
			expect(await findProjectByBoardFromDb('PVT_unknown')).toBeUndefined();
		});
	});

	describe('findProjectByIdFromDb', () => {
		it('maps a row back to a ProjectConfig', async () => {
			stubDb([row]);
			const project = await findProjectByIdFromDb('proj-1');
			expect(project).toMatchObject({ id: 'proj-1', pm: { type: 'github-projects' } });
		});

		it('returns undefined for an unknown id', async () => {
			stubDb([]);
			expect(await findProjectByIdFromDb('nope')).toBeUndefined();
		});
	});

	describe('upsertProjectToDb', () => {
		it('flattens pm.type into a column and upserts on the id', async () => {
			const { values, onConflictDoUpdate } = stubInsert();
			const project = createMockProjectConfig({ id: 'proj-1' });

			await upsertProjectToDb(project);

			const inserted = values.mock.calls[0][0];
			expect(inserted).toMatchObject({ id: 'proj-1', pmType: 'github-projects' });
			// The row shape is columns, not the nested `pm` object of the config.
			expect(inserted).not.toHaveProperty('pm');

			const [conflict] = onConflictDoUpdate.mock.calls[0];
			// Keyed on the id, which is itself excluded from the update set.
			expect(conflict.set).not.toHaveProperty('id');
			expect(conflict.set).toMatchObject({ pmType: 'github-projects' });
		});
	});
});
