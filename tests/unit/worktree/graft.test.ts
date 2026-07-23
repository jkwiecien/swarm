/**
 * Grafting is pure filesystem work, so these tests exercise real symlinks in an
 * OS temp dir rather than mocking `node:fs` — a mocked `fs` would assert nothing
 * about the one thing this module does. It's still hermetic: no network, no DB,
 * no touching the real repo (ai/TESTING.md "Unit tests").
 */

import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger.js';
import { DEFAULT_GRAFT_ENTRIES, graftEnvironment } from '@/worktree/graft.js';

describe('graftEnvironment', () => {
	let root: string;
	let repoRoot: string;
	let worktreeDir: string;

	beforeEach(() => {
		// realpathSync so later target assertions match on macOS, where tmpdir()
		// lives under the /var → /private/var symlink.
		root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-graft-')));
		repoRoot = join(root, 'repo');
		worktreeDir = join(repoRoot, '.swarm-workspaces', 'issue-1-x');
		mkdirSync(worktreeDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function seedSource(path: string, kind: 'dir' | 'file'): string {
		const full = join(repoRoot, path);
		if (kind === 'dir') {
			mkdirSync(full, { recursive: true });
		} else {
			writeFileSync(full, 'x');
		}
		return full;
	}

	it('symlinks the default set with absolute, realpath-resolved targets', () => {
		const nodeModules = seedSource('node_modules', 'dir');
		const webNodeModules = seedSource('dashboard/node_modules', 'dir');
		const env = seedSource('.env', 'file');

		const results = graftEnvironment(repoRoot, worktreeDir);

		for (const name of ['node_modules', 'dashboard/node_modules', '.env']) {
			const link = join(worktreeDir, name);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
		}
		expect(readlinkSync(join(worktreeDir, 'node_modules'))).toBe(nodeModules);
		expect(readlinkSync(join(worktreeDir, 'dashboard/node_modules'))).toBe(webNodeModules);
		expect(readlinkSync(join(worktreeDir, '.env'))).toBe(env);
		expect(results.find((r) => r.path === 'node_modules')?.status).toBe('linked');
		// cascade wasn't seeded, so it's an optional miss.
		expect(results.find((r) => r.path === 'cascade')?.status).toBe('skipped-missing');
	});

	it('resolves a symlinked source (the cascade pointer) to its real directory', () => {
		// Simulate the `cascade` sibling-checkout pointer: a symlink in the repo
		// root pointing at a directory outside it.
		const sibling = join(root, 'cascade-real');
		mkdirSync(sibling);
		symlinkSync(sibling, join(repoRoot, 'cascade'), 'dir');

		graftEnvironment(repoRoot, worktreeDir);

		// The worktree link points at the *real* directory, not the intermediate
		// symlink — matching `cd cascade && pwd -P`.
		expect(readlinkSync(join(worktreeDir, 'cascade'))).toBe(sibling);
	});

	it('is idempotent — a correct existing link is left as already-linked', () => {
		seedSource('node_modules', 'dir');

		graftEnvironment(repoRoot, worktreeDir);
		const results = graftEnvironment(repoRoot, worktreeDir);

		expect(results.find((r) => r.path === 'node_modules')?.status).toBe('already-linked');
	});

	it('leaves a pre-existing committed-style link (already at the realpath) untouched', () => {
		// A pre-existing symlink already points at the absolute realpath — either the
		// *committed* `cascade` link a worktree checks out, or a `node_modules` link a
		// prior graft (or the solve-issue skill) already created at runtime. graft must
		// recognise it as correct and not re-point it — re-pointing would dirty the
		// worktree and leak into the agent's PR. This differs from the idempotency test
		// above, which re-runs over a link graft itself created.
		const nodeModules = seedSource('node_modules', 'dir');
		symlinkSync(nodeModules, join(worktreeDir, 'node_modules'), 'dir');

		const results = graftEnvironment(repoRoot, worktreeDir);

		expect(results.find((r) => r.path === 'node_modules')?.status).toBe('already-linked');
		expect(readlinkSync(join(worktreeDir, 'node_modules'))).toBe(nodeModules);
	});

	it('re-points a stale symlink to the correct target', () => {
		const nodeModules = seedSource('node_modules', 'dir');
		const stale = join(root, 'somewhere-else');
		mkdirSync(stale);
		symlinkSync(stale, join(worktreeDir, 'node_modules'), 'dir');

		const results = graftEnvironment(repoRoot, worktreeDir);

		expect(results.find((r) => r.path === 'node_modules')?.status).toBe('linked');
		expect(readlinkSync(join(worktreeDir, 'node_modules'))).toBe(nodeModules);
	});

	it('warns but does not throw when a required source is missing', () => {
		const warn = vi.spyOn(logger, 'warn');

		const results = graftEnvironment(repoRoot, worktreeDir);

		expect(results.find((r) => r.path === 'node_modules')?.status).toBe('skipped-missing');
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('required source missing'),
			expect.objectContaining({ path: 'node_modules' }),
		);
	});

	it('skips optional missing sources silently', () => {
		const warn = vi.spyOn(logger, 'warn');
		// Only .env and cascade are optional and absent here; node_modules is seeded
		// so the only warnings would be about optional misses (there should be none).
		seedSource('node_modules', 'dir');

		graftEnvironment(repoRoot, worktreeDir);

		expect(warn).not.toHaveBeenCalled();
	});

	it('refuses to overwrite a real (non-symlink) destination', () => {
		seedSource('node_modules', 'dir');
		const warn = vi.spyOn(logger, 'warn');
		// A real directory squatting the destination — e.g. git-tracked content.
		mkdirSync(join(worktreeDir, 'node_modules'));

		const results = graftEnvironment(repoRoot, worktreeDir);

		expect(results.find((r) => r.path === 'node_modules')?.status).toBe('skipped-conflict');
		expect(lstatSync(join(worktreeDir, 'node_modules')).isSymbolicLink()).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('refusing to overwrite'),
			expect.objectContaining({ path: 'node_modules' }),
		);
	});

	it('grafts caller-supplied build-cache paths on top of the defaults', () => {
		const cache = seedSource('.turbo', 'dir');

		const results = graftEnvironment(repoRoot, worktreeDir, { buildCachePaths: ['.turbo'] });

		expect(readlinkSync(join(worktreeDir, '.turbo'))).toBe(cache);
		expect(results.find((r) => r.path === '.turbo')?.status).toBe('linked');
	});

	it('creates missing parent directories for nested cache paths', () => {
		const cache = seedSource(join('.cache', 'ts'), 'dir');

		graftEnvironment(repoRoot, worktreeDir, { buildCachePaths: ['.cache/ts'] });

		expect(readlinkSync(join(worktreeDir, '.cache', 'ts'))).toBe(cache);
	});

	it('honours a full entry-list override', () => {
		const only = seedSource('only-this', 'dir');

		const results = graftEnvironment(repoRoot, worktreeDir, {
			entries: [{ path: 'only-this' }],
		});

		expect(results).toHaveLength(1);
		expect(readlinkSync(join(worktreeDir, 'only-this'))).toBe(only);
	});

	it('throws on a non-absolute repoRoot', () => {
		expect(() => graftEnvironment('repo', worktreeDir)).toThrow(/absolute/);
	});

	it('throws on a non-absolute worktreeDir', () => {
		expect(() => graftEnvironment(repoRoot, 'worktree')).toThrow(/absolute/);
	});

	it('throws when the worktree does not exist', () => {
		expect(() => graftEnvironment(repoRoot, join(root, 'nope'))).toThrow(/does not exist/);
	});

	it('exposes the mandated default graft set', () => {
		expect(DEFAULT_GRAFT_ENTRIES.map((e) => e.path)).toEqual([
			'node_modules',
			'dashboard/node_modules',
			'.env',
			'cascade',
		]);
	});
});
