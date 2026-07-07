/**
 * Provisions and tears down the per-task git worktrees SWARM runs agents inside
 * (PROJECT.md §4, ai/ARCHITECTURE.md "Worktree lifecycle"). Each task gets an
 * isolated checkout under `<repoRoot>/<worktreeRoot>/task-<id>/` so the automated
 * agent and the human developer can work the same repository at once without
 * stepping on each other's index — the worktree shares the main repo's `.git`, so
 * creation is near-instant and costs no network.
 *
 * Scope (SWARM-14): the git worktree add/remove lifecycle plus the sanity-check +
 * fetch that precede it (§4.2 steps 1, 2, 5). Environment grafting — symlinking
 * `node_modules`, `.env`, and build caches into the worktree (§4.2 step 3) — is a
 * separate task (SWARM-15); `provision` exposes a seam for it (see the note there)
 * rather than implementing it here.
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from '../config/schema.js';
import { logger } from '../lib/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Canonicalize a path for equality comparison. `git worktree list --porcelain`
 * reports realpaths (symlinks resolved), so plain `resolve` on our side can miss
 * a match when a component is symlinked (classic case: macOS `/tmp` →
 * `/private/tmp`) — which would leak the main checkout into `list()`. Falls back
 * to `resolve` for a path that doesn't exist on disk yet.
 */
function canonicalize(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/** A provisioned worktree — the handle callers hold onto for the task's lifetime. */
export interface WorktreeHandle {
	/** The task identifier this worktree was provisioned for (usually the issue number). */
	taskId: string;
	/** Absolute path to the worktree checkout. */
	path: string;
	/**
	 * The branch checked out in the worktree. For a `detach`ed worktree there is no
	 * branch — this holds the ref the detached HEAD was placed at (the base branch).
	 */
	branch: string;
	/** True when the worktree is in detached HEAD (see {@link ProvisionOptions.detach}). */
	detached: boolean;
}

/** Options for {@link GitWorktreeManager.provision}. */
export interface ProvisionOptions {
	/**
	 * Branch to check out in the worktree. Defaults to `<branchPrefix><taskId>`
	 * (SWARM's `issue-<n>` convention, from the project config) when creating a
	 * branch; **required** when `createBranch` is false (there's no sensible
	 * default for an existing checkout target).
	 */
	branch?: string;
	/**
	 * When true (the default), cut `branch` fresh off `baseBranch` — the
	 * implementation-phase flow. When false, check out an existing `branch` (e.g.
	 * a PR branch for the review / respond-to-review phases).
	 */
	createBranch?: boolean;
	/** Ref the new branch is cut from when `createBranch` is true. Defaults to the project's `baseBranch`. */
	baseBranch?: string;
	/**
	 * Check out `baseBranch` in **detached HEAD** instead of on a branch — for a
	 * read-only phase (Planning: explore the code, write `proposed_plan.md`, throw
	 * the checkout away) that must not create or hold a task branch. It sidesteps
	 * two problems a branch would cause here: `git worktree add <path> main` refuses
	 * because `main` is already checked out in the primary tree, and cutting a fresh
	 * `issue-<n>` branch would both collide with the implementation phase (which
	 * wants that branch) and leave an orphan branch that breaks a re-run. Detached
	 * HEAD claims no branch, so cleanup is just `worktree remove` with nothing to
	 * delete. Takes precedence over `createBranch`; `branch` is ignored when set.
	 */
	detach?: boolean;
	/**
	 * Run `git fetch origin` before creating the worktree so the branch is cut
	 * from up-to-date refs (§4.2 step 1). Defaults to true; the fetch is
	 * best-effort — a failure (e.g. no remote yet) is logged, not fatal.
	 */
	fetch?: boolean;
}

/** Manages the git-worktree lifecycle for one SWARM project. Construct one per project. */
export class GitWorktreeManager {
	constructor(private readonly project: ProjectConfig) {}

	/** Absolute path to the worktree for `taskId` — `<repoRoot>/<worktreeRoot>/task-<id>` (§4.1). */
	worktreePath(taskId: string): string {
		return resolve(this.project.repoRoot, this.project.worktreeRoot, `task-${taskId}`);
	}

	/**
	 * Provision an isolated worktree for `taskId` and return its handle.
	 *
	 * Throws if the project's `repoRoot` isn't a git repository, or if a worktree
	 * for this task already exists (a stale one must be cleaned up first — an
	 * accidental overwrite would clobber unpushed agent work).
	 */
	async provision(taskId: string, options: ProvisionOptions = {}): Promise<WorktreeHandle> {
		await this.assertGitRepo();

		if (options.fetch !== false) {
			await this.fetch();
		}

		const path = this.worktreePath(taskId);
		if (existsSync(path)) {
			throw new Error(
				`Worktree for task '${taskId}' already exists at ${path} — clean it up before re-provisioning`,
			);
		}

		const baseBranch = options.baseBranch ?? this.project.baseBranch;
		const createBranch = options.createBranch ?? true;
		if (!options.detach && !createBranch && options.branch === undefined) {
			throw new Error(
				`Cannot check out an existing branch for task '${taskId}' without an explicit 'branch' — pass ProvisionOptions.branch when createBranch is false`,
			);
		}

		const detached = options.detach ?? false;
		// Detached HEAD has no branch; the handle reports the base ref it points at.
		const branch = detached
			? baseBranch
			: (options.branch ?? `${this.project.branchPrefix}${taskId}`);

		if (createBranch && !detached) {
			await this.reapOrphanedBranch(branch);
		}

		const args = ['worktree', 'add'];
		if (detached) {
			args.push('--detach', path, baseBranch);
		} else if (createBranch) {
			args.push('-b', branch, path, baseBranch);
		} else {
			args.push(path, branch);
		}

		logger.info('Provisioning worktree', { taskId, path, branch, createBranch, detached });
		await this.git(args);

		// SWARM-15 grafts untracked build state (node_modules, .env, caches) in here
		// via symlinks before the agent runs; git-tracked files (incl. the committed
		// `cascade` symlink) are already checked out by `git worktree add`.

		return { taskId, path, branch, detached };
	}

	/**
	 * Remove the worktree for `taskId` (§4.2 step 5). Idempotent: a missing
	 * worktree is a no-op (logged), not an error — "already gone" is the desired
	 * end state, not a bug (ai/CODING_STANDARDS.md "Error handling").
	 *
	 * Uses `--force` because the agent's uncommitted scratch (or a running process's
	 * open files) would otherwise block removal; the agent pushes anything worth
	 * keeping before cleanup runs.
	 */
	async cleanup(taskId: string): Promise<void> {
		const path = this.worktreePath(taskId);
		if (!existsSync(path)) {
			logger.warn('Worktree cleanup skipped — path does not exist', { taskId, path });
			return;
		}
		logger.info('Removing worktree', { taskId, path });
		await this.git(['worktree', 'remove', '--force', path]);
	}

	/**
	 * `cleanup()` only removes the worktree checkout, never the branch `provision`
	 * cut for it (§4.2 step 5 is silent on branches on purpose — a *successful*
	 * Implementation run needs `issue-<id>` to still exist locally so Review /
	 * Respond-to-review / Respond-to-CI can check it out again later). But that
	 * means a run that fails *before* pushing leaves a dangling local branch that
	 * blocks every retry with `fatal: a branch named '<x>' already exists`
	 * (confirmed live on #75). Delete that orphan, but only when it's provably
	 * safe to: if `origin` already has a matching ref, a PR may depend on it, so
	 * this leaves it alone and lets the `worktree add` failure below surface
	 * instead of risking real pushed work. Same caution on an `ls-remote` failure
	 * (network/config issue, can't verify either way) — assume the worst and skip.
	 */
	private async reapOrphanedBranch(branch: string): Promise<void> {
		const localExists = (await this.git(['branch', '--list', branch])).trim().length > 0;
		if (!localExists) return;

		let remoteHasIt: boolean;
		try {
			remoteHasIt = (await this.git(['ls-remote', '--heads', 'origin', branch])).trim().length > 0;
		} catch {
			remoteHasIt = true;
		}
		if (remoteHasIt) return;

		logger.warn('Deleting orphaned local branch left over from a previous failed run', { branch });
		await this.git(['branch', '-D', branch]);
	}

	/**
	 * Absolute paths of the worktrees git currently tracks for this repo, excluding
	 * the main checkout — the source of truth for reconciling orphaned sandboxes.
	 */
	async list(): Promise<string[]> {
		const stdout = await this.git(['worktree', 'list', '--porcelain']);
		const mainRoot = canonicalize(this.project.repoRoot);
		const paths: string[] = [];
		for (const line of stdout.split('\n')) {
			if (!line.startsWith('worktree ')) continue;
			const worktree = canonicalize(line.slice('worktree '.length).trim());
			if (worktree !== mainRoot) paths.push(worktree);
		}
		return paths;
	}

	/** Verify `repoRoot` exists and is a git working tree (§4.2 step 1). */
	private async assertGitRepo(): Promise<void> {
		if (!existsSync(this.project.repoRoot)) {
			throw new Error(`Project repo root does not exist: ${this.project.repoRoot}`);
		}
		try {
			await this.git(['rev-parse', '--is-inside-work-tree']);
		} catch {
			throw new Error(`Not a git repository: ${this.project.repoRoot}`);
		}
	}

	/** Best-effort `git fetch origin` — a failure (no remote, offline) is logged, not thrown. */
	private async fetch(): Promise<void> {
		try {
			await this.git(['fetch', 'origin']);
		} catch (err) {
			logger.warn('git fetch origin failed — continuing with local refs', {
				repoRoot: this.project.repoRoot,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Run a git command in the project's repo root and return its stdout. Uses
	 * argv (not a shell string) so task IDs / branch names can't inject shell
	 * syntax. Throws with the captured stderr on a non-zero exit.
	 */
	private async git(args: string[]): Promise<string> {
		try {
			const { stdout } = await execFileAsync('git', args, { cwd: this.project.repoRoot });
			return stdout;
		} catch (err) {
			const stderr =
				typeof err === 'object' && err !== null && 'stderr' in err
					? String((err as { stderr: unknown }).stderr)
					: '';
			const message = stderr.trim() || (err instanceof Error ? err.message : String(err));
			throw new Error(`git ${args.join(' ')} failed: ${message}`);
		}
	}
}
