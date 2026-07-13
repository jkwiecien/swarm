import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DELEGATION_ENV } from '@/delegation/native.js';

const runDelegatedChild = vi.fn();
vi.mock('@/delegation/orchestrator.js', async (importActual) => ({
	...(await importActual<typeof import('@/delegation/orchestrator.js')>()),
	runDelegatedChild,
}));

const { run } = await import('@/cli/commands/delegate.js');

const validContract = {
	version: 1,
	id: 'docs-update',
	delegationType: 'documentation-edit',
	agent: 'swarm-doc-editor',
	task: 'Update the documentation from the decided facts.',
	decidedFacts: ['A decided fact worth stating.'],
	allowedPaths: ['README.md'],
	prohibitedScope: ['No source changes.'],
	expectedArtifact: 'Updated README section.',
	verification: { command: 'npm run lint', evidence: 'exit code 0' },
	reviewRequired: true,
	estimatedSemanticOperations: 4,
};

const ENV_KEYS = Object.values(DELEGATION_ENV);
let saved: Record<string, string | undefined>;
let cwd: string;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) delete process.env[k];
	cwd = mkdtempSync(join(tmpdir(), 'swarm-delegate-'));
	// process.chdir() is unavailable in vitest workers; pin cwd instead.
	vi.spyOn(process, 'cwd').mockReturnValue(cwd);
	runDelegatedChild.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

function enableDelegation(): void {
	process.env[DELEGATION_ENV.childCli] = 'codex';
	process.env[DELEGATION_ENV.lightModel] = 'gpt-5.4-mini';
	process.env[DELEGATION_ENV.minimumOperations] = '3';
	process.env[DELEGATION_ENV.parentRunId] = 'run-1';
	process.env[DELEGATION_ENV.phase] = 'implementation';
}

function writeManifest(contract: unknown = validContract): string {
	writeFileSync(join(cwd, 'contract.json'), JSON.stringify(contract));
	return 'contract.json';
}

describe('swarm delegate', () => {
	it('requires a contract file argument', async () => {
		enableDelegation();
		expect(await run([])).toBe(2);
	});

	it('refuses nested delegation from a child', async () => {
		enableDelegation();
		process.env[DELEGATION_ENV.depth] = '1';
		expect(await run([writeManifest()])).toBe(2);
		expect(runDelegatedChild).not.toHaveBeenCalled();
	});

	it('refuses when the host kill switch is off', async () => {
		enableDelegation();
		process.env[DELEGATION_ENV.killSwitch] = 'false';
		expect(await run([writeManifest()])).toBe(2);
		expect(runDelegatedChild).not.toHaveBeenCalled();
	});

	it('refuses when no child CLI/model is configured for the run', async () => {
		expect(await run([writeManifest()])).toBe(2);
		expect(runDelegatedChild).not.toHaveBeenCalled();
	});

	it('runs the child, records the observation, and returns its exit code', async () => {
		enableDelegation();
		runDelegatedChild.mockResolvedValue({
			observation: {
				invocationId: 'inv-1',
				contractId: 'docs-update',
				parentRunId: 'run-1',
				phase: 'implementation',
				agent: 'swarm-doc-editor',
				model: 'gpt-5.4-mini',
				delegationType: 'documentation-edit',
				allowedPaths: ['README.md'],
				outcome: 'completed',
				reviewDisposition: 'unreported',
			},
			report: 'Delegation completed.',
			exitCode: 0,
		});

		expect(await run([writeManifest()])).toBe(0);

		expect(runDelegatedChild).toHaveBeenCalledWith(
			expect.objectContaining({
				cli: 'codex',
				model: 'gpt-5.4-mini',
				phase: 'implementation',
				parentRunId: 'run-1',
				minimumSemanticOperations: 3,
				contract: expect.objectContaining({ id: 'docs-update' }),
			}),
		);
		const events = readFileSync(join(cwd, '.swarm-delegation-events.jsonl'), 'utf8');
		expect(JSON.parse(events.trim())).toMatchObject({
			invocationId: 'inv-1',
			outcome: 'completed',
		});
	});

	it('rejects an invalid contract with exit 2 before launching a child', async () => {
		enableDelegation();
		expect(await run([writeManifest({ ...validContract, allowedPaths: [] })])).toBe(2);
		expect(runDelegatedChild).not.toHaveBeenCalled();
	});
});
