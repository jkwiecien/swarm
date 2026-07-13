import { z } from 'zod';

import type { ProjectConfig } from '@/config/schema.js';
import type { AgentCli, RunAgentCliOptions } from '@/harness/agent-cli.js';
import { AgentUsageSchema } from '@/harness/usage.js';
import type { TriggerPhase } from '@/triggers/types.js';

export const CURATED_DOCUMENTATION_AGENT = 'swarm-doc-editor';
export const CURATED_COORDINATOR_AGENT = 'swarm-phase-coordinator';
export const DELEGATION_EVENTS_FILENAME = '.swarm-delegation-events.jsonl';
export const DELEGATION_REVIEW_FILENAME = '.swarm-delegation-review.json';

export const DelegationContractSchema = z.object({
	version: z.literal(1),
	id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
	delegationType: z.literal('documentation-edit'),
	agent: z.literal(CURATED_DOCUMENTATION_AGENT),
	task: z.string().min(20),
	decidedFacts: z.array(z.string().min(1)).min(1),
	allowedPaths: z
		.array(z.string().min(1))
		.min(1)
		.refine((paths) => new Set(paths).size === paths.length, 'allowedPaths must be unique'),
	prohibitedScope: z.array(z.string().min(1)).min(1),
	expectedArtifact: z.string().min(10),
	verification: z.object({ command: z.string().min(1), evidence: z.string().min(1) }),
	reviewRequired: z.literal(true),
	estimatedSemanticOperations: z.number().int().positive(),
	maxTurns: z.number().int().min(1).max(12),
});
export type DelegationContract = z.infer<typeof DelegationContractSchema>;

export const DelegationReviewSchema = z.object({
	delegations: z.array(
		z.object({
			contractId: z.string().min(1),
			disposition: z.enum(['accepted', 'reworked']),
			note: z.string().min(1),
		}),
	),
});

export const DelegationObservationSchema = z.object({
	contractId: z.string().min(1),
	parentRunId: z.string().optional(),
	parentSessionId: z.string().optional(),
	phase: z.string().min(1),
	agent: z.literal(CURATED_DOCUMENTATION_AGENT),
	model: z.string().min(1),
	delegationType: z.literal('documentation-edit'),
	allowedPaths: z.array(z.string()),
	durationMs: z.number().int().nonnegative().optional(),
	usage: AgentUsageSchema.optional(),
	outcome: z.enum(['completed', 'rejected', 'failed']),
	reviewDisposition: z.enum(['accepted', 'reworked', 'unreported']).default('unreported'),
});
export type DelegationObservation = z.infer<typeof DelegationObservationSchema>;

const phaseConfigKey: Record<
	TriggerPhase,
	keyof NonNullable<NonNullable<ProjectConfig['agents']>['delegation']>['phases']
> = {
	planning: 'planning',
	implementation: 'implementation',
	review: 'review',
	'respond-to-review': 'respondToReview',
	'respond-to-ci': 'respondToCi',
	'resolve-conflicts': 'resolveConflicts',
};

type DelegationPolicy = NonNullable<NonNullable<ProjectConfig['agents']>['delegation']>;
type DelegationRunContext = { project: ProjectConfig; phase: TriggerPhase; runId?: string };

/**
 * Provider seam for a CLI's supported native delegation mechanism.
 *
 * Contracts, policy, prompt guards, observations, and persistence remain
 * provider-neutral. A future Codex or Antigravity implementation supplies one
 * adapter here without changing pipeline phases or the worker lifecycle.
 */
export interface NativeDelegationAdapter {
	readonly cli: AgentCli;
	configureRun(
		options: RunAgentCliOptions,
		context: DelegationRunContext,
		policy: DelegationPolicy,
	): RunAgentCliOptions;
}

const claudeNativeDelegationAdapter: NativeDelegationAdapter = {
	cli: 'claude',
	configureRun(options, context, policy) {
		return {
			...options,
			providerArgs: ['--agent', CURATED_COORDINATOR_AGENT, ...(options.providerArgs ?? [])],
			env: {
				...options.env,
				CLAUDE_CODE_SUBAGENT_MODEL: policy.model,
				SWARM_DELEGATION_MINIMUM_OPERATIONS: String(policy.minimumSemanticOperations),
				SWARM_PARENT_RUN_ID: context.runId ?? '',
				SWARM_PARENT_SESSION_ID: options.sessionId ?? options.resumeSessionId ?? '',
				SWARM_PIPELINE_PHASE: context.phase,
			},
		};
	},
};

/** Explicit capability registry for every CLI understood by the harness. */
const nativeDelegationAdapters: Record<AgentCli, NativeDelegationAdapter | undefined> = {
	claude: claudeNativeDelegationAdapter,
	antigravity: undefined,
	codex: undefined,
};

export function nativeDelegationAdapterFor(cli: AgentCli): NativeDelegationAdapter | undefined {
	return nativeDelegationAdapters[cli];
}

export function nativeDelegationEnabled(
	project: ProjectConfig,
	phase: TriggerPhase,
	cli: AgentCli,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!nativeDelegationAdapterFor(cli) || env.SWARM_NATIVE_DELEGATION_ENABLED === 'false') {
		return false;
	}
	const policy = project.agents?.delegation;
	return policy?.enabled === true && policy.phases[phaseConfigKey[phase]] === true;
}

export function configureNativeDelegationRun(
	options: RunAgentCliOptions,
	context: DelegationRunContext,
): RunAgentCliOptions {
	if (!nativeDelegationEnabled(context.project, context.phase, options.cli)) return options;
	const policy = context.project.agents?.delegation;
	const adapter = nativeDelegationAdapterFor(options.cli);
	if (!policy || !adapter) return options;
	return adapter.configureRun(options, context, policy);
}

export function delegationGuardLines(enabled: boolean): readonly string[] {
	if (!enabled) {
		return ['Do NOT spawn subagents. No native delegation is enabled for this project and phase.'];
	}
	return [
		`You may invoke only the curated \`${CURATED_DOCUMENTATION_AGENT}\` native subagent, and only`,
		'for substantial, bounded documentation editing whose facts and placement are already decided.',
		'Arbitrary agents, skills, cross-phase work, architecture/design decisions, migrations, security',
		'or concurrency reasoning, broad refactors, and deterministic commands remain prohibited.',
		'Every request must contain one `<swarm-delegation-contract>` JSON object matching the project',
		'contract: exact task and decidedFacts; allowedPaths; prohibitedScope; expectedArtifact;',
		'verification command/evidence; reviewRequired:true; estimatedSemanticOperations; and maxTurns.',
		'Do not delegate below the configured minimum. After the child returns, inspect its complete diff,',
		'accept or rework it yourself, run verification yourself, and write `.swarm-delegation-review.json`',
		'with `{ "delegations": [{ "contractId", "disposition": "accepted"|"reworked", "note" }] }`.',
		'Never delegate commit, push, PR/review/comment/board mutation, formatting-only work, prescribed',
		'commands, verification execution, metadata collection, hand-off mechanics, or final judgment.',
	];
}

export function hasUnreviewedCompletedDelegation(
	observations: DelegationObservation[] | undefined,
): boolean {
	return (
		observations?.some(
			(observation) =>
				observation.outcome === 'completed' && observation.reviewDisposition === 'unreported',
		) ?? false
	);
}
