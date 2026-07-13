import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readDelegationObservations } from '@/delegation/observations.js';

describe('readDelegationObservations', () => {
	it('links child usage and primary disposition to the parent record', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'swarm-delegation-'));
		writeFileSync(
			join(cwd, '.swarm-delegation-events.jsonl'),
			`${JSON.stringify({
				invocationId: 'session-1:agent-1',
				contractId: 'docs-update',
				parentRunId: 'run-1',
				parentSessionId: 'session-1',
				phase: 'implementation',
				agent: 'swarm-doc-editor',
				model: 'haiku',
				delegationType: 'documentation-edit',
				allowedPaths: ['README.md'],
				durationMs: 25,
				usage: { inputTokens: 10, outputTokens: 5 },
				outcome: 'completed',
			})}\nnot-json\n`,
		);
		writeFileSync(
			join(cwd, '.swarm-delegation-review.json'),
			JSON.stringify({
				delegations: [
					{
						invocationId: 'session-1:agent-1',
						contractId: 'docs-update',
						disposition: 'accepted',
						note: 'Diff checked.',
					},
				],
			}),
		);
		expect(readDelegationObservations(cwd, { parentSessionId: 'session-1' })).toEqual([
			expect.objectContaining({
				contractId: 'docs-update',
				parentRunId: 'run-1',
				usage: { inputTokens: 10, outputTokens: 5 },
				reviewDisposition: 'accepted',
			}),
		]);
	});

	it('does not attribute stale session events or same-contract reviews to a fresh invocation', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'swarm-delegation-'));
		const base = {
			contractId: 'docs-update',
			parentRunId: 'run-1',
			phase: 'implementation',
			agent: 'swarm-doc-editor',
			model: 'haiku',
			delegationType: 'documentation-edit',
			allowedPaths: ['README.md'],
			outcome: 'completed',
		};
		writeFileSync(
			join(cwd, '.swarm-delegation-events.jsonl'),
			`${JSON.stringify({ ...base, invocationId: 'old:agent-1', parentSessionId: 'old' })}\n${JSON.stringify({ ...base, invocationId: 'fresh:agent-2', parentSessionId: 'fresh' })}\n`,
		);
		writeFileSync(
			join(cwd, '.swarm-delegation-review.json'),
			JSON.stringify({
				delegations: [
					{
						invocationId: 'old:agent-1',
						contractId: 'docs-update',
						disposition: 'accepted',
						note: 'Old diff only.',
					},
					{
						invocationId: 'fresh:agent-2',
						contractId: 'different-contract',
						disposition: 'accepted',
						note: 'Different contract.',
					},
				],
			}),
		);

		expect(readDelegationObservations(cwd, { parentSessionId: 'fresh' })).toEqual([
			expect.objectContaining({
				invocationId: 'fresh:agent-2',
				reviewDisposition: 'unreported',
			}),
		]);
	});
});
