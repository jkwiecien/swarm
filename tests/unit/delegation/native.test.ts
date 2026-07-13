import { describe, expect, it } from 'vitest';

import {
	configureDelegationRun,
	DEFAULT_LIGHT_MODEL,
	DELEGATION_CHILD_CAPABLE,
	DELEGATION_ENV,
	DelegationContractSchema,
	delegationEnabled,
	delegationGuardLines,
	hasUnreviewedCompletedDelegation,
	resolveLightModel,
} from '@/delegation/native.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const project = createMockProjectConfig({
	agents: {
		delegation: {
			enabled: true,
			minimumSemanticOperations: 3,
			phases: { implementation: true },
		},
	},
});

describe('curated delegation policy', () => {
	it('enables only child-capable CLIs on opted-in phases, honouring the kill switch', () => {
		// Codex is now child-capable (issue #184); antigravity is not (#185).
		expect(DELEGATION_CHILD_CAPABLE).toEqual({ claude: true, codex: true, antigravity: false });

		expect(delegationEnabled(project, 'implementation', 'claude', {})).toBe(true);
		expect(delegationEnabled(project, 'implementation', 'codex', {})).toBe(true);
		expect(delegationEnabled(project, 'review', 'claude', {})).toBe(false);
		expect(delegationEnabled(project, 'implementation', 'antigravity', {})).toBe(false);
		expect(
			delegationEnabled(project, 'implementation', 'claude', {
				[DELEGATION_ENV.killSwitch]: 'false',
			}),
		).toBe(false);
	});

	it('resolves the per-CLI child model, falling back to the coded default', () => {
		const policy = { enabled: true, minimumSemanticOperations: 3, phases: {} };
		expect(resolveLightModel(policy, 'claude')).toBe('haiku');
		expect(resolveLightModel(policy, 'codex')).toBe(DEFAULT_LIGHT_MODEL.codex);
		expect(resolveLightModel({ ...policy, lightModels: { codex: 'gpt-5.5' } }, 'codex')).toBe(
			'gpt-5.5',
		);
	});

	it('injects delegation env for the child command without adding any provider flags', () => {
		const configured = configureDelegationRun(
			{ cli: 'codex', cwd: '/worktree', args: ['prompt'], env: { GH_TOKEN: 'token' } },
			{ project, phase: 'implementation', runId: 'run-1' },
		);
		expect(configured.providerArgs).toBeUndefined();
		expect(configured.env).toMatchObject({
			GH_TOKEN: 'token',
			[DELEGATION_ENV.childCli]: 'codex',
			[DELEGATION_ENV.lightModel]: DEFAULT_LIGHT_MODEL.codex,
			[DELEGATION_ENV.minimumOperations]: '3',
			[DELEGATION_ENV.parentRunId]: 'run-1',
			[DELEGATION_ENV.phase]: 'implementation',
		});
		expect(configured.env?.[DELEGATION_ENV.command]).toBeTruthy();
	});

	it('leaves the run untouched when delegation is not enabled for the phase/CLI', () => {
		const options = { cli: 'antigravity' as const, cwd: '/worktree', args: ['prompt'] };
		expect(configureDelegationRun(options, { project, phase: 'implementation' })).toBe(options);
	});

	it('guards against subagents when disabled and describes the command flow when enabled', () => {
		expect(delegationGuardLines(false).join('\n')).toContain('Do NOT spawn subagents');
		const enabled = delegationGuardLines(true).join('\n');
		expect(enabled).toContain(`$${DELEGATION_ENV.command}`);
		expect(enabled).toContain('.swarm-delegation-review.json');
		expect(enabled).toMatch(/Do NOT spawn/i);
		// Teaches the agent to self-filter delegations that would not pay off.
		expect(enabled).toMatch(/pay off/i);
		expect(enabled).toMatch(/apply-to-decide/i);
	});

	it('validates a structured contract and rejects underspecified requests', () => {
		const valid = {
			version: 1,
			id: 'docs-config-update',
			delegationType: 'documentation-edit',
			agent: 'swarm-doc-editor',
			task: 'Update the documented configuration from the supplied facts.',
			decidedFacts: ['The child model defaults are per-CLI.'],
			allowedPaths: ['README.md'],
			prohibitedScope: ['No source changes.'],
			expectedArtifact: 'Updated README configuration entry.',
			verification: { command: 'npm run lint', evidence: 'exit code 0' },
			reviewRequired: true,
			estimatedSemanticOperations: 3,
		};
		expect(DelegationContractSchema.parse(valid)).toEqual(valid);
		expect(DelegationContractSchema.safeParse({ ...valid, allowedPaths: [] }).success).toBe(false);
		expect(DelegationContractSchema.safeParse({ ...valid, reviewRequired: false }).success).toBe(
			false,
		);
	});

	it('requires the primary to record acceptance or rework for every completed child', () => {
		const base = {
			invocationId: 'inv-1',
			contractId: 'docs-update',
			phase: 'implementation',
			agent: 'swarm-doc-editor' as const,
			model: 'haiku',
			delegationType: 'documentation-edit' as const,
			allowedPaths: ['README.md'],
			outcome: 'completed' as const,
		};
		expect(hasUnreviewedCompletedDelegation([{ ...base, reviewDisposition: 'unreported' }])).toBe(
			true,
		);
		expect(hasUnreviewedCompletedDelegation([{ ...base, reviewDisposition: 'accepted' }])).toBe(
			false,
		);
		expect(
			hasUnreviewedCompletedDelegation([
				{ ...base, outcome: 'rejected', reviewDisposition: 'unreported' },
			]),
		).toBe(false);
	});
});
