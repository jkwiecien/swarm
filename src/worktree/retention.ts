import { realpathSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import type { ProjectConfig } from '../config/schema.js';
import { PROJECT_DEFAULTS } from '../config/schema.js';
import { hasResumableDeferredRun } from '../db/repositories/runsRepository.js';
import { logger } from '../lib/logger.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import { isWorktreeLeased } from './worktree-lease.js';

export interface PruneStaleWorktreesOptions {
	/** Injectable for tests; defaults to `new GitWorktreeManager(project)`. */
	worktrees?: GitWorktreeManager;
	/** Report what would happen without actually removing anything. */
	dryRun?: boolean;
	/** Injectable deferred-session pin lookup for tests. */
	isDeferredPinned?: (projectId: string, taskId: string) => Promise<boolean>;
}

export interface PruneStaleWorktreesResult {
	kept: string[];
	pruned: string[];
	skippedInFlight: string[];
	skippedDirty: string[];
	skippedDeferred: string[];
	/** Worktrees under worktreeRoot that don't match `task-<id>` — left alone entirely (see plan's scope note on legacy worktrees). */
	ignored: string[];
}

const TASK_DIR_PATTERN = /^task-(.+)$/;

interface MatchedEntry {
	path: string;
	taskId: string;
	mtimeMs: number;
}

function canonicalize(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

function getMatchedEntries(
	paths: string[],
	normalizedRoot: string,
	ignored: string[],
): MatchedEntry[] {
	const matchedEntries: MatchedEntry[] = [];
	for (const p of paths) {
		const canonicalPath = canonicalize(p);
		if (!canonicalPath.startsWith(normalizedRoot)) {
			ignored.push(p);
			continue;
		}

		const baseName = basename(canonicalPath);
		const match = baseName.match(TASK_DIR_PATTERN);
		if (!match) {
			ignored.push(p);
			continue;
		}

		const taskId = match[1];
		try {
			const stat = statSync(canonicalPath);
			matchedEntries.push({
				path: p,
				taskId,
				mtimeMs: stat.mtimeMs,
			});
		} catch (err) {
			logger.warn('Failed to stat worktree path, ignoring', { path: p, error: String(err) });
			ignored.push(p);
		}
	}
	return matchedEntries;
}

async function processCandidateEntries(
	candidates: MatchedEntry[],
	project: ProjectConfig,
	worktrees: GitWorktreeManager,
	options: PruneStaleWorktreesOptions,
	pruned: string[],
	skippedInFlight: string[],
	skippedDirty: string[],
	skippedDeferred: string[],
): Promise<void> {
	for (const candidate of candidates) {
		const { path, taskId } = candidate;
		if (await isWorktreeLeased(project.id, taskId)) {
			skippedInFlight.push(path);
			continue;
		}
		const isDeferredPinned = options.isDeferredPinned ?? hasResumableDeferredRun;
		if (await isDeferredPinned(project.id, taskId)) {
			skippedDeferred.push(path);
			continue;
		}
		if (!(await worktrees.isClean(taskId))) {
			skippedDirty.push(path);
			continue;
		}
		if (!options.dryRun) {
			await worktrees.cleanup(taskId);
		}
		pruned.push(path);
	}
}

export async function pruneStaleWorktrees(
	project: ProjectConfig,
	options: PruneStaleWorktreesOptions = {},
): Promise<PruneStaleWorktreesResult> {
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);
	const paths = await worktrees.list();

	const kept: string[] = [];
	const pruned: string[] = [];
	const skippedInFlight: string[] = [];
	const skippedDirty: string[] = [];
	const skippedDeferred: string[] = [];
	const ignored: string[] = [];

	const worktreeRootCanonical = canonicalize(resolve(project.repoRoot, project.worktreeRoot));
	const normalizedRoot = worktreeRootCanonical.endsWith(sep)
		? worktreeRootCanonical
		: worktreeRootCanonical + sep;

	const matchedEntries = getMatchedEntries(paths, normalizedRoot, ignored);

	// Sort matched entries by mtimeMs descending (most recently touched first)
	matchedEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);

	const maxWorktrees = project.worktreeRetention?.maxWorktrees ?? PROJECT_DEFAULTS.maxWorktrees;

	const keptEntries = matchedEntries.slice(0, maxWorktrees);
	const candidateEntries = matchedEntries.slice(maxWorktrees);

	for (const entry of keptEntries) {
		kept.push(entry.path);
	}

	await processCandidateEntries(
		candidateEntries,
		project,
		worktrees,
		options,
		pruned,
		skippedInFlight,
		skippedDirty,
		skippedDeferred,
	);

	logger.debug('worktree retention sweep complete', {
		projectId: project.id,
		kept: kept.length,
		pruned: pruned.length,
		skippedInFlight: skippedInFlight.length,
		skippedDirty: skippedDirty.length,
		skippedDeferred: skippedDeferred.length,
		ignored: ignored.length,
	});

	for (const dirtyPath of skippedDirty) {
		logger.warn('worktree skipped during retention sweep — has uncommitted changes', {
			projectId: project.id,
			path: dirtyPath,
		});
	}

	return {
		kept,
		pruned,
		skippedInFlight,
		skippedDirty,
		skippedDeferred,
		ignored,
	};
}
