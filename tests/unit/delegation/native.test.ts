import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	configureNativeDelegationRun,
	DelegationContractSchema,
	hasUnreviewedCompletedDelegation,
	nativeDelegationAdapterFor,
	nativeDelegationEnabled,
} from '@/delegation/native.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const project = createMockProjectConfig({
	agents: {
		delegation: {
			enabled: true,
			model: 'haiku',
			minimumSemanticOperations: 3,
			phases: { implementation: true },
		},
	},
});

describe('native delegation policy', () => {
	it('targets every known CLI through an explicit capability registry', () => {
		expect(nativeDelegationAdapterFor('claude')?.cli).toBe('claude');
		expect(nativeDelegationAdapterFor('antigravity')).toBeUndefined();
		expect(nativeDelegationAdapterFor('codex')).toBeUndefined();

		expect(nativeDelegationEnabled(project, 'implementation', 'claude', {})).toBe(true);
		expect(nativeDelegationEnabled(project, 'review', 'claude', {})).toBe(false);
		expect(nativeDelegationEnabled(project, 'implementation', 'antigravity', {})).toBe(false);
		expect(nativeDelegationEnabled(project, 'implementation', 'codex', {})).toBe(false);
		expect(
			nativeDelegationEnabled(project, 'implementation', 'claude', {
				SWARM_NATIVE_DELEGATION_ENABLED: 'false',
			}),
		).toBe(false);
	});

	it('pins the trusted child model and coordinator at the Claude adapter seam', () => {
		const configured = configureNativeDelegationRun(
			{ cli: 'claude', cwd: '/worktree', args: ['prompt'], env: { GH_TOKEN: 'token' } },
			{ project, phase: 'implementation', runId: 'run-1' },
		);
		expect(configured.providerArgs).toEqual(['--agent', 'swarm-phase-coordinator']);
		expect(configured.env).toMatchObject({
			GH_TOKEN: 'token',
			CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
			SWARM_DELEGATION_MINIMUM_OPERATIONS: '3',
			SWARM_PARENT_RUN_ID: 'run-1',
			SWARM_PIPELINE_PHASE: 'implementation',
		});
	});

	it('validates a structured contract and rejects underspecified requests', () => {
		const valid = {
			version: 1,
			id: 'docs-config-update',
			delegationType: 'documentation-edit',
			agent: 'swarm-doc-editor',
			task: 'Update the documented configuration from the supplied facts.',
			decidedFacts: ['The global switch is SWARM_NATIVE_DELEGATION_ENABLED.'],
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
		expect(DelegationContractSchema.safeParse({ ...valid, maxTurns: 1 }).success).toBe(false);
	});

	it('defines a Haiku child without command, skill, GitHub, or nested-agent tools', () => {
		const definition = readFileSync('.claude/agents/swarm-doc-editor.md', 'utf8');
		expect(definition).toContain('model: haiku');
		expect(definition).toContain('maxTurns: 12');
		expect(definition).toContain('tools: Read, Edit');
		expect(definition).not.toMatch(/^tools:.*(?:Bash|Agent|Skill)/m);
		const coordinator = readFileSync('.claude/agents/swarm-phase-coordinator.md', 'utf8');
		expect(coordinator).toContain('Agent(swarm-doc-editor)');
		expect(coordinator).not.toMatch(/Agent\([^)]*,/);
	});

	it('requires the primary to record acceptance or rework for every completed child', () => {
		const base = {
			invocationId: 'session-1:agent-1',
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
	});
});
