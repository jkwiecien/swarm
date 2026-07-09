import type { Stats } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { pruneStaleWorktrees } from '@/worktree/retention.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// Mock worktree lease check
const { isWorktreeLeasedMock } = vi.hoisted(() => ({
	isWorktreeLeasedMock: vi.fn(),
}));

vi.mock('@/worktree/worktree-lease.js', () => ({
	isWorktreeLeased: isWorktreeLeasedMock,
	claimWorktreeLease: vi.fn(),
	releaseWorktreeLease: vi.fn(),
}));

// Mock statSync
const { statSyncMock } = vi.hoisted(() => ({
	statSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs')>();
	return {
		...original,
		statSync: statSyncMock,
	};
});

// A small local stub/fake for GitWorktreeManager
class FakeGitWorktreeManager extends GitWorktreeManager {
	private mockList: string[] = [];
	private cleanMap = new Map<string, boolean>();
	public cleanedUpTasks: string[] = [];

	setWorktreesList(paths: string[]) {
		this.mockList = paths;
	}

	setTaskCleanliness(taskId: string, clean: boolean) {
		this.cleanMap.set(taskId, clean);
	}

	override async list(): Promise<string[]> {
		return this.mockList;
	}

	override async isClean(taskId: string): Promise<boolean> {
		return this.cleanMap.get(taskId) ?? true;
	}

	override async cleanup(taskId: string): Promise<void> {
		this.cleanedUpTasks.push(taskId);
	}
}

describe('pruneStaleWorktrees', () => {
	beforeEach(() => {
		isWorktreeLeasedMock.mockReset();
		isWorktreeLeasedMock.mockResolvedValue(false);
		statSyncMock.mockReset();
	});

	it('keeps the maxWorktrees most-recently-touched task-<id> worktrees and prunes the rest', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 2 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
		]);

		// task-3 is newest, task-1 is oldest
		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			if (path.endsWith('task-2')) return { mtimeMs: 2000 } as unknown as Stats;
			if (path.endsWith('task-3')) return { mtimeMs: 3000 } as unknown as Stats;
			throw new Error('Unknown path in statSyncMock');
		});

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toEqual([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
		]);
		expect(result.pruned).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(manager.cleanedUpTasks).toEqual(['1']);
		expect(result.skippedInFlight).toEqual([]);
		expect(result.skippedDirty).toEqual([]);
		expect(result.ignored).toEqual([]);
	});

	it('falls back to PROJECT_DEFAULTS.maxWorktrees when config is omitted', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: undefined,
		});

		const manager = new FakeGitWorktreeManager(project);
		// generate 12 worktrees, 10 should be kept, 2 pruned (since default maxWorktrees is 10)
		const list: string[] = [];
		for (let i = 1; i <= 12; i++) {
			list.push(`/Users/dev/swarm/swarm/.swarm-workspaces/task-${i}`);
		}
		manager.setWorktreesList(list);

		statSyncMock.mockImplementation((path: string) => {
			const num = parseInt(path.split('task-')[1], 10);
			return { mtimeMs: num * 1000 } as unknown as Stats; // task-12 is newest
		});

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toHaveLength(10);
		expect(result.pruned).toEqual([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
		]);
		expect(manager.cleanedUpTasks).toEqual(['2', '1']);
	});

	it('skips (does not prune) an old worktree that is leased, and does not backfill', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 2 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
		]);

		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			if (path.endsWith('task-2')) return { mtimeMs: 2000 } as unknown as Stats;
			if (path.endsWith('task-3')) return { mtimeMs: 3000 } as unknown as Stats;
			throw new Error('Unknown path');
		});

		// task-1 is leased/in-flight
		isWorktreeLeasedMock.mockImplementation(async (_projId, taskId) => taskId === '1');

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toEqual([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
		]);
		expect(result.pruned).toEqual([]);
		expect(result.skippedInFlight).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('skips an old worktree that is dirty', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 2 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
		]);

		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			if (path.endsWith('task-2')) return { mtimeMs: 2000 } as unknown as Stats;
			if (path.endsWith('task-3')) return { mtimeMs: 3000 } as unknown as Stats;
			throw new Error('Unknown path');
		});

		// task-1 is dirty
		manager.setTaskCleanliness('1', false);

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toEqual([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
		]);
		expect(result.pruned).toEqual([]);
		expect(result.skippedDirty).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('leaves non-task-<id>-named directories alone and reports them as ignored', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 1 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/issue-10-spike',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
		]);

		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			throw new Error('Should not stat non-task directory');
		});

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(result.ignored).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/issue-10-spike']);
		expect(result.pruned).toEqual([]);
	});

	it('computes same lists on dryRun: true but does not run cleanup', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 2 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
		]);

		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			if (path.endsWith('task-2')) return { mtimeMs: 2000 } as unknown as Stats;
			if (path.endsWith('task-3')) return { mtimeMs: 3000 } as unknown as Stats;
			throw new Error('Unknown path');
		});

		const result = await pruneStaleWorktrees(project, { worktrees: manager, dryRun: true });

		expect(result.kept).toEqual([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
		]);
		expect(result.pruned).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(manager.cleanedUpTasks).toEqual([]); // Did NOT clean up
	});

	it('filters out any git-reported worktree path outside repoRoot/worktreeRoot', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 1 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/some-other-place/task-2',
		]);

		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			throw new Error('Should not stat path outside root');
		});

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(result.ignored).toEqual(['/Users/dev/some-other-place/task-2']);
		expect(result.pruned).toEqual([]);
	});
});
