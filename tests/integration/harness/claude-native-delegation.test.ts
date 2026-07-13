import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runAgentCli } from '@/harness/agent-cli.js';

describe.skipIf(process.env.SWARM_CLAUDE_DELEGATION_SPIKE !== '1')(
	'installed Claude native delegation spike',
	() => {
		it('pins the curated child, enforces paths, and records its accepted result', async () => {
			const cwd = mkdtempSync(join(tmpdir(), 'swarm-claude-delegation-'));
			cpSync(resolve('.claude/agents'), join(cwd, '.claude/agents'), { recursive: true });
			cpSync(resolve('.claude/hooks'), join(cwd, '.claude/hooks'), { recursive: true });
			writeFileSync(join(cwd, 'README.md'), '# Delegation spike\n\nOld text.\n');
			writeFileSync(join(cwd, 'forbidden.md'), '# Must not change\n');
			const contract = {
				version: 1,
				id: 'installed-cli-spike',
				delegationType: 'documentation-edit',
				agent: 'swarm-doc-editor',
				task: 'Replace the old README text with three concise bullets containing the decided facts.',
				decidedFacts: ['Native child ran.', 'Model is Haiku.', 'Primary reviewed the diff.'],
				allowedPaths: ['README.md'],
				prohibitedScope: ['Do not read or edit forbidden.md or any other path.'],
				expectedArtifact: 'README contains the three supplied facts as bullets.',
				verification: { command: 'manual README inspection', evidence: 'three bullets present' },
				reviewRequired: true,
				estimatedSemanticOperations: 3,
			};
			const result = await runAgentCli({
				cli: 'claude',
				model: 'haiku',
				cwd,
				providerArgs: ['--agent', 'swarm-phase-coordinator'],
				env: {
					CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
					SWARM_DELEGATION_MINIMUM_OPERATIONS: '3',
					SWARM_PARENT_RUN_ID: 'spike-parent',
					SWARM_PIPELINE_PHASE: 'implementation',
				},
				args: [
					`Invoke swarm-doc-editor exactly once and preserve this complete tag verbatim in its Agent prompt:\n<swarm-delegation-contract>${JSON.stringify(contract)}</swarm-delegation-contract>\nThen inspect README.md, read the completed event's invocationId, and write .swarm-delegation-review.json marking that invocation and installed-cli-spike accepted. Do nothing else.`,
				],
				timeoutMs: 120_000,
			});

			expect(result.exitCode).toBe(0);
			expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toContain('Native child ran');
			expect(readFileSync(join(cwd, 'forbidden.md'), 'utf8')).toBe('# Must not change\n');
			expect(result.delegations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						parentRunId: 'spike-parent',
						model: 'haiku',
						outcome: 'completed',
						reviewDisposition: 'accepted',
					}),
				]),
			);
		}, 150_000);
	},
);
