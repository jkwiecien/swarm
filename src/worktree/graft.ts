/**
 * Environment grafting for task worktrees.
 *
 * A fresh `git worktree add` only checks out tracked files. The untracked-but-
 * required state a build actually needs — installed dependencies, local secrets,
 * the `cascade` sibling-checkout pointer, and tool build caches — is gitignored,
 * so a new worktree can't type-check, run tests, or resolve `cascade` until that
 * state is grafted in. Rather than re-`npm install` per worktree (slow, and it
 * would multiply disk usage across every concurrent task), we symlink the main
 * checkout's copy in — the standard worktree pattern from `ai/ARCHITECTURE.md`
 * "Worktree lifecycle".
 *
 * The links MUST use **absolute** targets (`ai/RULES.md` §1): a worktree lives
 * at `<repoRoot>/.swarm-workspaces/<name>/`, so a relative `../node_modules`
 * would dangle two levels down. `realpathSync` on the source gives us that
 * absolute target and, as a bonus, resolves the `cascade` sibling-checkout
 * symlink to its real directory — the same thing the solve-issue skill does with
 * `cd cascade && pwd -P`.
 *
 * This module is *only* the grafting step. Provisioning/cleanup of the worktree
 * itself (`git worktree add` / `git worktree remove`) is the GitWorktreeManager
 * (SWARM-14), which calls this after creating the worktree.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	realpathSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { logger } from '../lib/logger.js';

/** One thing to graft into a worktree. */
export interface GraftEntry {
	/** Path relative to both `repoRoot` (the source) and the worktree (the link). */
	path: string;
	/**
	 * When true, a missing source is worth a warning — the worktree probably
	 * won't build without it (e.g. `node_modules`). Optional sources (`.env`,
	 * `cascade`, caches) are skipped silently.
	 */
	required?: boolean;
}

/**
 * The architecture-mandated graft set (`ai/ARCHITECTURE.md` "Worktree lifecycle"):
 * `.env`, `node_modules`, `cascade`. Build caches are project-specific — which
 * directories are safe-to-share caches vs. per-branch build *output* depends on
 * the toolchain — so they're passed via {@link GraftEnvironmentOptions.buildCachePaths}
 * rather than hard-coded here.
 */
export const DEFAULT_GRAFT_ENTRIES: readonly GraftEntry[] = [
	{ path: 'node_modules', required: true },
	{ path: '.env' },
	{ path: 'cascade' },
];

export interface GraftEnvironmentOptions {
	/**
	 * Extra relative paths to graft on top of {@link DEFAULT_GRAFT_ENTRIES},
	 * e.g. tool build caches (`.turbo`, `.cache`). Each is optional — skipped
	 * silently when the source doesn't exist.
	 */
	buildCachePaths?: string[];
	/**
	 * Replace the default entry list entirely. Mainly for tests; production
	 * callers should prefer `buildCachePaths` so they keep the mandated defaults.
	 */
	entries?: readonly GraftEntry[];
}

export type GraftStatus =
	/** A new symlink was created (or a wrong-target one re-pointed). */
	| 'linked'
	/** The symlink already pointed at the correct absolute target — left as-is. */
	| 'already-linked'
	/** The source doesn't exist in the main checkout — nothing to link. */
	| 'skipped-missing'
	/** A real (non-symlink) file/dir occupies the destination — refused to clobber. */
	| 'skipped-conflict';

export interface GraftResult {
	path: string;
	status: GraftStatus;
	/** The absolute symlink target, when one was resolved. */
	target?: string;
}

/**
 * Symlink the untracked-but-required state from `repoRoot` into `worktreeDir`.
 *
 * Idempotent: re-running leaves correct links untouched (so re-grafting the
 * committed `cascade` symlink keeps git clean) and re-points stale ones. Never
 * overwrites a real file/dir at the destination — that would risk destroying
 * git-tracked content — it warns and skips instead.
 *
 * Throws if `repoRoot`/`worktreeDir` aren't absolute or the worktree doesn't
 * exist: those are programmer errors, not "not found" lookups
 * (`ai/CODING_STANDARDS.md` "Error handling").
 */
export function graftEnvironment(
	repoRoot: string,
	worktreeDir: string,
	options: GraftEnvironmentOptions = {},
): GraftResult[] {
	if (!isAbsolute(repoRoot)) {
		throw new Error(`graftEnvironment: repoRoot must be an absolute path, got "${repoRoot}"`);
	}
	if (!isAbsolute(worktreeDir)) {
		throw new Error(`graftEnvironment: worktreeDir must be an absolute path, got "${worktreeDir}"`);
	}
	if (!existsSync(worktreeDir)) {
		throw new Error(`graftEnvironment: worktree does not exist: "${worktreeDir}"`);
	}

	const entries = [
		...(options.entries ?? DEFAULT_GRAFT_ENTRIES),
		...(options.buildCachePaths ?? []).map((path) => ({ path }) satisfies GraftEntry),
	];

	return entries.map((entry) => graftOne(repoRoot, worktreeDir, entry));
}

function graftOne(repoRoot: string, worktreeDir: string, entry: GraftEntry): GraftResult {
	const sourcePath = join(repoRoot, entry.path);
	if (!existsSync(sourcePath)) {
		if (entry.required) {
			logger.warn('graft: required source missing — worktree may not build', {
				path: entry.path,
				sourcePath,
			});
		}
		return { path: entry.path, status: 'skipped-missing' };
	}

	// realpathSync gives an absolute target and resolves any symlink in the source
	// (notably the `cascade` sibling-checkout pointer) to its real directory.
	const target = realpathSync(sourcePath);
	const dest = join(worktreeDir, entry.path);

	const existing = lstatSyncOrNull(dest);
	if (existing?.isSymbolicLink()) {
		if (readlinkSync(dest) === target) {
			return { path: entry.path, status: 'already-linked', target };
		}
		// unlink, not rm: rmSync follows a symlink-to-directory and refuses without
		// `recursive`; unlinkSync removes the link itself regardless of its target.
		unlinkSync(dest);
	} else if (existing) {
		// A real (non-symlink) file or directory — likely git-tracked content the
		// worktree checked out. Clobbering it could destroy tracked state, so bail.
		logger.warn('graft: refusing to overwrite existing non-symlink destination', {
			path: entry.path,
			dest,
		});
		return { path: entry.path, status: 'skipped-conflict' };
	}

	// Support nested cache paths (e.g. `.cache/foo`) whose parent isn't the
	// worktree root yet. `recursive` is a no-op when the parent already exists.
	mkdirSync(dirname(dest), { recursive: true });
	symlinkSync(target, dest, statSync(target).isDirectory() ? 'dir' : 'file');
	logger.debug('graft: linked', { path: entry.path, target });
	return { path: entry.path, status: 'linked', target };
}

function lstatSyncOrNull(path: string): ReturnType<typeof lstatSync> | null {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}
