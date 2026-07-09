import { beforeEach, describe, expect, it, vi } from 'vitest';

const { RedisMock, set, del, exists, on } = vi.hoisted(() => {
	const set = vi.fn();
	const del = vi.fn();
	const exists = vi.fn();
	const on = vi.fn();
	const RedisMock = vi.fn(() => ({ set, del, exists, on }));
	return { RedisMock, set, del, exists, on };
});

vi.mock('ioredis', () => ({ Redis: RedisMock }));

beforeEach(() => {
	vi.resetModules();
	RedisMock.mockClear();
	set.mockReset();
	set.mockResolvedValue('OK');
	del.mockReset();
	del.mockResolvedValue(1);
	exists.mockReset();
	exists.mockResolvedValue(0);
	on.mockReset();
	process.env.REDIS_URL = 'redis://localhost:6379';
});

const NS = 'swarm:worktree-lease:';

describe('buildLeaseKey', () => {
	it('joins projectId and taskId', async () => {
		const { buildLeaseKey } = await import('@/worktree/worktree-lease.js');
		expect(buildLeaseKey('project-1', 'task-2')).toBe('project-1:task-2');
	});
});

describe('claimWorktreeLease', () => {
	it('claims with SET key 1 EX 14400', async () => {
		const { claimWorktreeLease } = await import('@/worktree/worktree-lease.js');

		await claimWorktreeLease('project-1', 'task-2');

		expect(set).toHaveBeenCalledWith(`${NS}project-1:task-2`, '1', 'EX', 14400);
	});

	it('swallows errors and does not throw', async () => {
		set.mockRejectedValue(new Error('ECONNREFUSED'));
		const { claimWorktreeLease } = await import('@/worktree/worktree-lease.js');

		await expect(claimWorktreeLease('project-1', 'task-2')).resolves.toBeUndefined();
	});
});

describe('releaseWorktreeLease', () => {
	it('deletes the namespaced key', async () => {
		const { releaseWorktreeLease } = await import('@/worktree/worktree-lease.js');

		await releaseWorktreeLease('project-1', 'task-2');

		expect(del).toHaveBeenCalledWith(`${NS}project-1:task-2`);
	});

	it('swallows errors and does not throw', async () => {
		del.mockRejectedValue(new Error('ECONNREFUSED'));
		const { releaseWorktreeLease } = await import('@/worktree/worktree-lease.js');

		await expect(releaseWorktreeLease('project-1', 'task-2')).resolves.toBeUndefined();
	});
});

describe('isWorktreeLeased', () => {
	it('returns true when EXISTS returns 1', async () => {
		exists.mockResolvedValue(1);
		const { isWorktreeLeased } = await import('@/worktree/worktree-lease.js');

		const leased = await isWorktreeLeased('project-1', 'task-2');

		expect(leased).toBe(true);
		expect(exists).toHaveBeenCalledWith(`${NS}project-1:task-2`);
	});

	it('returns false when EXISTS returns 0', async () => {
		exists.mockResolvedValue(0);
		const { isWorktreeLeased } = await import('@/worktree/worktree-lease.js');

		const leased = await isWorktreeLeased('project-1', 'task-2');

		expect(leased).toBe(false);
	});

	it('fails closed (returns true) when the check throws', async () => {
		exists.mockRejectedValue(new Error('ECONNREFUSED'));
		const { isWorktreeLeased } = await import('@/worktree/worktree-lease.js');

		const leased = await isWorktreeLeased('project-1', 'task-2');

		expect(leased).toBe(true);
	});
});
