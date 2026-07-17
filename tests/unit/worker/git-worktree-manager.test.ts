import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The module under test wraps `execFile` in `promisify`. `execFile` is
// callback-style and our mock carries no custom-promisify symbol, so
// `promisify` resolves with whatever we pass as the callback's second arg —
// i.e. `{ stdout, stderr }`. `gitHandler` lets each test decide the outcome of
// every git invocation; `gitCalls` records the exact argv for assertions.
const { claimWorktreeLeaseMock, releaseWorktreeLeaseMock } = vi.hoisted(() => ({
	claimWorktreeLeaseMock: vi.fn(),
	releaseWorktreeLeaseMock: vi.fn(),
}));

vi.mock('@/worktree/worktree-lease.js', () => ({
	claimWorktreeLease: claimWorktreeLeaseMock,
	releaseWorktreeLease: releaseWorktreeLeaseMock,
	isWorktreeLeased: vi.fn(),
}));

type GitOutcome = { stdout?: string; stderr?: string } | Error;
let gitHandler: (args: string[]) => GitOutcome;
const gitCalls: string[][] = [];
const gitOpts: unknown[] = [];

vi.mock('node:child_process', () => ({
	execFile: (
		_cmd: string,
		args: string[],
		opts: unknown,
		cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
	) => {
		gitCalls.push(args);
		gitOpts.push(opts);
		const outcome = gitHandler(args);
		if (outcome instanceof Error) cb(outcome);
		else cb(null, { stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' });
	},
}));

// Filesystem presence is fully controlled per test via `existingPaths`;
// `realpaths` overrides symlink resolution for the symlink-robustness test
// (default: identity).
let existingPaths: Set<string>;
let realpaths: Map<string, string>;
vi.mock('node:fs', () => ({
	existsSync: (p: string) => existingPaths.has(p),
	realpathSync: (p: string) => {
		const real = realpaths.get(p);
		if (real !== undefined) return real;
		if (existingPaths.has(p)) return p;
		throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
	},
}));

import { GitWorktreeManager, WorktreeAlreadyExistsError } from '@/worker/git-worktree-manager.js';

const REPO_ROOT = '/Users/dev/swarm/swarm';
const WORKTREE_14 = `${REPO_ROOT}/.swarm-workspaces/task-14`;

function makeManager(overrides = {}) {
	return new GitWorktreeManager(createMockProjectConfig({ repoRoot: REPO_ROOT, ...overrides }));
}

describe('GitWorktreeManager', () => {
	beforeEach(() => {
		gitCalls.length = 0;
		gitOpts.length = 0;
		gitHandler = () => ({ stdout: '' });
		claimWorktreeLeaseMock.mockReset();
		releaseWorktreeLeaseMock.mockReset();
		// Default world: the repo root exists and is a git repo; no worktrees yet.
		existingPaths = new Set([REPO_ROOT]);
		realpaths = new Map();
	});

	describe('worktreePath', () => {
		it('resolves to <repoRoot>/<worktreeRoot>/task-<id>', () => {
			expect(makeManager().worktreePath('14')).toBe(WORKTREE_14);
		});
	});

	describe('reuse', () => {
		it('does not adopt an existing worktree when its delivery-progress guard rejects it', async () => {
			existingPaths.add(WORKTREE_14);

			await expect(
				makeManager().reuse('14', 'issue-14', false, () => false),
			).resolves.toBeUndefined();
			expect(claimWorktreeLeaseMock).not.toHaveBeenCalled();
		});
	});

	describe('provision', () => {
		it('sanity-checks, fetches, then creates a fresh branch off baseBranch by default', async () => {
			const handle = await makeManager().provision('14');

			expect(gitCalls).toEqual([
				['rev-parse', '--is-inside-work-tree'],
				['fetch', 'origin'],
				['branch', '--list', 'issue-14'],
				['worktree', 'add', '-b', 'issue-14', WORKTREE_14, 'main'],
			]);
			expect(handle).toEqual({
				taskId: '14',
				path: WORKTREE_14,
				branch: 'issue-14',
				detached: false,
			});
		});

		it('checks out baseBranch in detached HEAD when detach is set (planning phase)', async () => {
			const handle = await makeManager().provision('14', { detach: true });

			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '--detach', WORKTREE_14, 'main']);
			expect(handle).toEqual({
				taskId: '14',
				path: WORKTREE_14,
				branch: 'main',
				detached: true,
			});
		});

		it('detach takes precedence over createBranch and ignores an explicit branch', async () => {
			await makeManager().provision('14', {
				detach: true,
				createBranch: true,
				branch: 'ignored',
				baseBranch: 'develop',
			});
			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '--detach', WORKTREE_14, 'develop']);
		});

		it('checks out an existing branch when createBranch is false (review phase)', async () => {
			const handle = await makeManager().provision('14', {
				createBranch: false,
				branch: 'issue-14-some-feature',
			});

			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', WORKTREE_14, 'issue-14-some-feature']);
			expect(handle.branch).toBe('issue-14-some-feature');
		});

		it('honours explicit branch and baseBranch overrides', async () => {
			await makeManager().provision('14', { branch: 'hotfix', baseBranch: 'develop' });
			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '-b', 'hotfix', WORKTREE_14, 'develop']);
		});

		it('skips the fetch when fetch is false', async () => {
			await makeManager().provision('14', { fetch: false });
			expect(gitCalls.some((c) => c[0] === 'fetch')).toBe(false);
		});

		it('continues (best-effort) when git fetch fails', async () => {
			gitHandler = (args) => (args[0] === 'fetch' ? new Error('no remote') : { stdout: '' });
			const handle = await makeManager().provision('14');
			expect(handle.path).toBe(WORKTREE_14);
			expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(true);
		});

		it('throws when createBranch is false and no branch is given', async () => {
			await expect(makeManager().provision('14', { createBranch: false })).rejects.toThrow(
				/without an explicit 'branch'/,
			);
			expect(gitCalls.some((c) => c[1] === 'add')).toBe(false);
		});

		it('throws if a worktree for the task already exists', async () => {
			existingPaths.add(WORKTREE_14);
			await expect(makeManager().provision('14')).rejects.toThrow(WorktreeAlreadyExistsError);
			expect(gitCalls.some((c) => c[1] === 'add')).toBe(false);
		});

		it('throws when the repo root does not exist', async () => {
			existingPaths = new Set();
			await expect(makeManager().provision('14')).rejects.toThrow(/repo root does not exist/);
			expect(gitCalls).toHaveLength(0);
		});

		it('throws when the repo root is not a git repository', async () => {
			gitHandler = (args) =>
				args[0] === 'rev-parse' ? new Error('fatal: not a git repository') : { stdout: '' };
			await expect(makeManager().provision('14')).rejects.toThrow(/Not a git repository/);
		});

		it('surfaces git stderr when worktree add fails', async () => {
			gitHandler = (args) => {
				if (args[1] === 'add') return Object.assign(new Error('exit 128'), { stderr: 'boom' });
				return { stdout: '' };
			};
			await expect(makeManager().provision('14')).rejects.toThrow(/git worktree add.*boom/);
		});

		it('deletes an orphaned local branch (no matching ref on origin) before retrying worktree add', async () => {
			gitHandler = (args) => {
				if (args[0] === 'branch' && args[1] === '--list') return { stdout: '  issue-14\n' };
				if (args[0] === 'ls-remote') return { stdout: '' };
				return { stdout: '' };
			};
			const handle = await makeManager().provision('14');

			expect(gitCalls).toContainEqual(['branch', '--list', 'issue-14']);
			expect(gitCalls).toContainEqual(['ls-remote', '--heads', 'origin', 'issue-14']);
			expect(gitCalls).toContainEqual(['branch', '-D', 'issue-14']);
			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '-b', 'issue-14', WORKTREE_14, 'main']);
			expect(handle.branch).toBe('issue-14');
		});

		it('leaves a local branch alone (and lets worktree add fail) when origin already has a matching ref', async () => {
			gitHandler = (args) => {
				if (args[0] === 'branch' && args[1] === '--list') return { stdout: '  issue-14\n' };
				if (args[0] === 'ls-remote') return { stdout: 'abc123\trefs/heads/issue-14\n' };
				if (args[0] === 'worktree' && args[1] === 'add') {
					return Object.assign(new Error('exit 128'), {
						stderr: "fatal: a branch named 'issue-14' already exists",
					});
				}
				return { stdout: '' };
			};

			await expect(makeManager().provision('14')).rejects.toThrow(/already exists/);
			expect(gitCalls.some((c) => c[0] === 'branch' && c[1] === '-D')).toBe(false);
		});

		it('leaves a local branch alone when the remote check itself fails (cannot verify)', async () => {
			gitHandler = (args) => {
				if (args[0] === 'branch' && args[1] === '--list') return { stdout: '  issue-14\n' };
				if (args[0] === 'ls-remote') return new Error('could not resolve host');
				if (args[0] === 'worktree' && args[1] === 'add') {
					return Object.assign(new Error('exit 128'), {
						stderr: "fatal: a branch named 'issue-14' already exists",
					});
				}
				return { stdout: '' };
			};

			await expect(makeManager().provision('14')).rejects.toThrow(/already exists/);
			expect(gitCalls.some((c) => c[0] === 'branch' && c[1] === '-D')).toBe(false);
		});

		it('skips the orphaned-branch check entirely for detached or existing-branch checkouts', async () => {
			await makeManager().provision('14', { detach: true });
			expect(gitCalls.some((c) => c[0] === 'branch')).toBe(false);

			gitCalls.length = 0;
			await makeManager().provision('14', { createBranch: false, branch: 'issue-14-x' });
			expect(gitCalls.some((c) => c[0] === 'branch')).toBe(false);
		});

		it('claims a worktree lease after successful provision', async () => {
			const project = createMockProjectConfig({ id: 'project-1' });
			const manager = new GitWorktreeManager(project);
			await manager.provision('14');
			expect(claimWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '14');
		});
	});

	describe('cleanup', () => {
		it('force-removes the worktree when it exists', async () => {
			existingPaths.add(WORKTREE_14);
			await makeManager().cleanup('14');
			expect(gitCalls).toEqual([['worktree', 'remove', '--force', WORKTREE_14]]);
		});

		it('is a no-op when the worktree is already gone', async () => {
			await makeManager().cleanup('14');
			expect(gitCalls).toHaveLength(0);
		});

		it('releases the worktree lease unconditionally', async () => {
			existingPaths.add(WORKTREE_14);
			const project = createMockProjectConfig({ id: 'project-1' });
			const manager = new GitWorktreeManager(project);
			await manager.cleanup('14');
			expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '14');

			// Also when the path does not exist
			existingPaths.delete(WORKTREE_14);
			releaseWorktreeLeaseMock.mockClear();
			await manager.cleanup('14');
			expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '14');
		});
	});

	describe('isClean', () => {
		it('returns true when git status --porcelain is empty', async () => {
			gitHandler = (args) => {
				if (args[0] === 'status' && args[1] === '--porcelain') {
					return { stdout: '' };
				}
				return { stdout: '' };
			};
			const manager = makeManager();
			const result = await manager.isClean('14');
			expect(result).toBe(true);
			const lastCallIndex = gitCalls.findIndex((c) => c[0] === 'status');
			expect(gitOpts[lastCallIndex]).toEqual({ cwd: WORKTREE_14 });
		});

		it('returns false when git status --porcelain is non-empty', async () => {
			gitHandler = (args) => {
				if (args[0] === 'status' && args[1] === '--porcelain') {
					return { stdout: ' M package.json\n?? untracked.txt\n' };
				}
				return { stdout: '' };
			};
			const manager = makeManager();
			const result = await manager.isClean('14');
			expect(result).toBe(false);
		});

		it('returns false and does not throw when the git command errors', async () => {
			gitHandler = (args) => {
				if (args[0] === 'status' && args[1] === '--porcelain') {
					return new Error('git status failed');
				}
				return { stdout: '' };
			};
			const manager = makeManager();
			const result = await manager.isClean('14');
			expect(result).toBe(false);
		});
	});

	describe('list', () => {
		it('returns tracked worktrees excluding the main checkout', async () => {
			gitHandler = () => ({
				stdout: [
					`worktree ${REPO_ROOT}`,
					'HEAD abc123',
					'branch refs/heads/main',
					'',
					`worktree ${WORKTREE_14}`,
					'HEAD def456',
					'branch refs/heads/issue-14',
					'',
				].join('\n'),
			});
			expect(await makeManager().list()).toEqual([WORKTREE_14]);
		});

		it('excludes the main checkout even when repoRoot sits under a symlink', async () => {
			// repoRoot is given via a symlinked path (e.g. /tmp), but git reports the
			// realpath (/private/tmp). Canonicalizing both sides must still match, so
			// the main checkout is not leaked into the list.
			const SYMLINKED_ROOT = '/tmp/swarm/swarm';
			const REAL_ROOT = '/private/tmp/swarm/swarm';
			const REAL_WORKTREE = '/private/tmp/swarm/swarm/.swarm-workspaces/task-14';
			existingPaths = new Set([SYMLINKED_ROOT]);
			realpaths = new Map([[SYMLINKED_ROOT, REAL_ROOT]]);
			gitHandler = () => ({
				stdout: [
					`worktree ${REAL_ROOT}`,
					'HEAD abc123',
					'branch refs/heads/main',
					'',
					`worktree ${REAL_WORKTREE}`,
					'HEAD def456',
					'branch refs/heads/issue-14',
					'',
				].join('\n'),
			});
			expect(await makeManager({ repoRoot: SYMLINKED_ROOT }).list()).toEqual([REAL_WORKTREE]);
		});
	});
});
