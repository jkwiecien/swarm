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
				contractId: 'docs-update',
				parentRunId: 'run-1',
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
					{ contractId: 'docs-update', disposition: 'accepted', note: 'Diff checked.' },
				],
			}),
		);
		expect(readDelegationObservations(cwd)).toEqual([
			expect.objectContaining({
				contractId: 'docs-update',
				parentRunId: 'run-1',
				usage: { inputTokens: 10, outputTokens: 5 },
				reviewDisposition: 'accepted',
			}),
		]);
	});
});
