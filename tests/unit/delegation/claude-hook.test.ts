import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const hook = resolve('.claude/hooks/swarm-doc-editor.mjs');

function contract(estimatedSemanticOperations = 3): string {
	return `<swarm-delegation-contract>${JSON.stringify({
		version: 1,
		id: 'docs-update',
		delegationType: 'documentation-edit',
		agent: 'swarm-doc-editor',
		task: 'Update the documented behavior from facts already supplied by the coordinator.',
		decidedFacts: ['The setting defaults to disabled.'],
		allowedPaths: ['README.md'],
		prohibitedScope: ['Do not change source files.'],
		expectedArtifact: 'README describes the setting.',
		verification: { command: 'npm run lint', evidence: 'exit code 0' },
		reviewRequired: true,
		estimatedSemanticOperations,
		maxTurns: 8,
	})}</swarm-delegation-contract>`;
}

function invoke(cwd: string, filePath: string, estimatedSemanticOperations = 3) {
	const transcriptPath = join(cwd, 'transcript.jsonl');
	writeFileSync(
		transcriptPath,
		`${JSON.stringify({ message: contract(estimatedSemanticOperations) })}\n`,
	);
	return spawnSync(process.execPath, [hook, 'validate'], {
		cwd,
		input: JSON.stringify({
			cwd,
			transcript_path: transcriptPath,
			agent_id: 'agent-1',
			tool_input: { file_path: filePath },
		}),
		env: {
			...process.env,
			SWARM_DELEGATION_MINIMUM_OPERATIONS: '3',
			SWARM_PIPELINE_PHASE: 'implementation',
		},
		encoding: 'utf8',
	});
}

describe('swarm-doc-editor hook', () => {
	it('allows an exact documentation path and rejects out-of-scope edits', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'swarm-doc-hook-'));
		writeFileSync(join(cwd, 'README.md'), '# Test\n');
		writeFileSync(join(cwd, 'source.ts'), 'export {};\n');
		expect(invoke(cwd, 'README.md').status).toBe(0);
		const rejected = invoke(cwd, 'source.ts');
		expect(rejected.status).toBe(2);
		expect(rejected.stderr).toContain('outside allowedPaths');
		expect(readFileSync(join(cwd, '.swarm-delegation-events.jsonl'), 'utf8')).toContain(
			'"outcome":"rejected"',
		);
	});

	it('rejects trivial delegation below the trusted threshold', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'swarm-doc-hook-'));
		writeFileSync(join(cwd, 'README.md'), '# Test\n');
		const rejected = invoke(cwd, 'README.md', 2);
		expect(rejected.status).toBe(2);
		expect(rejected.stderr).toContain('below the minimum 3');
	});

	it('blocks the coordinator stop until every completed child has a review disposition', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'swarm-doc-hook-'));
		writeFileSync(
			join(cwd, '.swarm-delegation-events.jsonl'),
			`${JSON.stringify({ contractId: 'docs-update', outcome: 'completed' })}\n`,
		);
		const runReviewHook = () =>
			spawnSync(process.execPath, [hook, 'review'], {
				cwd,
				input: JSON.stringify({ cwd }),
				encoding: 'utf8',
			});
		expect(runReviewHook().status).toBe(2);
		writeFileSync(
			join(cwd, '.swarm-delegation-review.json'),
			JSON.stringify({
				delegations: [
					{ contractId: 'docs-update', disposition: 'accepted', note: 'Inspected the diff.' },
				],
			}),
		);
		expect(runReviewHook().status).toBe(0);
	});
});
