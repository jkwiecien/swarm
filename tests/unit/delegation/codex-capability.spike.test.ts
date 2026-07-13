/**
 * Installed-CLI capability spike for issue #184 (docs/OPTIMIZATION.md §6).
 *
 * This is the executable record of the Codex delegation spike: it asserts what
 * the *installed* `codex` CLI actually exposes, so the claims that justify
 * SWARM's Option-B (orchestrated child-run) choice can't silently drift as Codex
 * evolves. It is skipped when `codex` isn't on PATH (CI without the CLI), rather
 * than failing — a skip is a "couldn't verify here", not a regression.
 *
 * Findings encoded below (Codex CLI 0.144.x):
 *  - `codex exec` runs a *single* agent — there is no `--agent`/subagent flag and
 *    no curated-child mechanism, so native Claude-style (Option A) delegation is
 *    impossible; delegation must be SWARM-orchestrated (Option B).
 *  - The Option-B building blocks all exist: `--model` (pin), `--sandbox`
 *    workspace-write + `-C` (confine writes), `--json` (usage attribution).
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function codexHelp(args: string[]): string | undefined {
	try {
		return execFileSync('codex', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		return undefined;
	}
}

const execHelp = codexHelp(['exec', '--help']);
const codexAvailable = execHelp !== undefined;

describe.skipIf(!codexAvailable)('codex delegation capability spike', () => {
	it('has no native subagent/agent mechanism (so Option B is required)', () => {
		expect(execHelp).toBeDefined();
		const help = execHelp ?? '';
		// The only "agent" references are to the single primary agent, never a
		// spawnable curated subagent.
		expect(help).not.toMatch(/--agent\b/);
		expect(help).not.toMatch(/subagent/i);
	});

	it('exposes the Option-B building blocks: model pin, sandbox+cwd, JSON usage', () => {
		const help = execHelp ?? '';
		expect(help).toMatch(/--model\b/);
		expect(help).toMatch(/--sandbox\b/);
		expect(help).toMatch(/workspace-write/);
		expect(help).toMatch(/-C, --cd\b|--cd\b/);
		expect(help).toMatch(/--json\b/);
	});
});
