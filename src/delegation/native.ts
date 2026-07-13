import { z } from 'zod';

import type { ProjectConfig } from '@/config/schema.js';
import type { AgentCli, RunAgentCliOptions } from '@/harness/agent-cli.js';
import { AgentUsageSchema } from '@/harness/usage.js';
import type { TriggerPhase } from '@/triggers/types.js';

/**
 * Provider-neutral curated delegation — the SWARM-orchestrated child-run model
 * (docs/OPTIMIZATION.md §6 "Option B"). A pipeline phase's primary agent can
 * hand a substantial-but-bounded semantic operation (today only documentation
 * editing) to a curated, lighter-model *child run* that SWARM launches, pins,
 * sandboxes, and accounts for — rather than to the CLI's own native subagent
 * mechanism (the retired "Option A"). This module owns the pieces that stay the
 * same for every CLI: the delegation contract the primary writes, the policy
 * gate, the prompt guard, the run-time env the child launcher reads, and the
 * persisted observation shape. The child launcher itself lives in
 * `./orchestrator.ts`; the `swarm delegate` entry the primary invokes lives in
 * `src/cli/commands/delegate.ts`.
 *
 * The filename is kept for churn's sake; nothing here is CLI-"native" anymore.
 */

/** The curated role a delegation targets — a domain label, not a CLI agent name. */
export const CURATED_DOCUMENTATION_AGENT = 'swarm-doc-editor';
export const DELEGATION_EVENTS_FILENAME = '.swarm-delegation-events.jsonl';
export const DELEGATION_REVIEW_FILENAME = '.swarm-delegation-review.json';
/**
 * Glob covering every delegation scratch file the primary/child write into the
 * worktree — the events log, the review file, and the per-delegation contract
 * manifests (`.swarm-delegation-<id>.contract.json`). `src/scm/delivery.ts`
 * excludes it from the committed diff so delegation bookkeeping never lands in a
 * PR.
 */
export const DELEGATION_SCRATCH_GLOB = '.swarm-delegation-*';

/** Fixed turn ceiling for a curated child run — a contract cannot raise it. */
export const DELEGATION_CHILD_MAX_TURNS = 12;

/** Env var names shared by the config injector and the `swarm delegate` command. */
export const DELEGATION_ENV = {
	/** Host kill switch: `'false'` disables delegation everywhere, over project config. */
	killSwitch: 'SWARM_DELEGATION_ENABLED',
	childCli: 'SWARM_DELEGATION_CHILD_CLI',
	childModel: 'SWARM_DELEGATION_CHILD_MODEL',
	minimumOperations: 'SWARM_DELEGATION_MINIMUM_OPERATIONS',
	parentRunId: 'SWARM_PARENT_RUN_ID',
	parentSessionId: 'SWARM_PARENT_SESSION_ID',
	phase: 'SWARM_PIPELINE_PHASE',
	/** Recursion guard: set to `'1'` on the child so it cannot delegate again. */
	depth: 'SWARM_DELEGATION_DEPTH',
	/** The exact command the primary must run to delegate (host-overridable). */
	command: 'SWARM_DELEGATE_COMMAND',
} as const;

/** Default `swarm delegate` invocation when the host sets no override. */
export const DEFAULT_DELEGATE_COMMAND = 'swarm delegate';

export const DelegationContractSchema = z
	.object({
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
	})
	.strict();
export type DelegationContract = z.infer<typeof DelegationContractSchema>;

export const DelegationReviewSchema = z.object({
	delegations: z.array(
		z.object({
			invocationId: z.string().min(1),
			contractId: z.string().min(1),
			disposition: z.enum(['accepted', 'reworked']),
			note: z.string().min(1),
		}),
	),
});

export const DelegationObservationSchema = z.object({
	invocationId: z.string().min(1),
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
 * Which CLIs can serve as a curated delegation *child*. A child is a
 * non-interactive run pinned to a lighter model with a restricted toolset and a
 * confined write scope, so a CLI qualifies only when the harness can launch it
 * that way (`./orchestrator.ts`). Claude (`claude -p --allowedTools`) and Codex
 * (`codex exec -s workspace-write`) qualify; Antigravity has no usable
 * tool/sandbox controls (ai/RULES.md §6, tracked by #185).
 */
export const DELEGATION_CHILD_CAPABLE: Record<AgentCli, boolean> = {
	claude: true,
	codex: true,
	antigravity: false,
};

/**
 * Coded per-CLI child model when a project pins none. A child should be a
 * genuinely cheaper tier than any sensible primary: Claude Haiku, Codex mini.
 */
export const DEFAULT_CHILD_MODEL: Record<AgentCli, string> = {
	claude: 'haiku',
	codex: 'gpt-5.4-mini',
	antigravity: '',
};

/** The lighter model a delegation child runs under for the given phase CLI. */
export function resolveChildModel(policy: DelegationPolicy, cli: AgentCli): string {
	// Only child-capable CLIs (claude/codex) can pin a `childModels` entry; a
	// non-capable CLI never reaches a live child, so fall straight to the default.
	const pinned = cli === 'antigravity' ? undefined : policy.childModels?.[cli];
	return pinned ?? DEFAULT_CHILD_MODEL[cli];
}

export function delegationEnabled(
	project: ProjectConfig,
	phase: TriggerPhase,
	cli: AgentCli,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!DELEGATION_CHILD_CAPABLE[cli] || env[DELEGATION_ENV.killSwitch] === 'false') {
		return false;
	}
	const policy = project.agents?.delegation;
	return policy?.enabled === true && policy.phases[phaseConfigKey[phase]] === true;
}

/**
 * Inject the delegation policy for this run into the primary agent's env, so the
 * `swarm delegate` command it invokes can read the child CLI/model, the minimum
 * size threshold, and the parent linkage. No provider flags are added — unlike
 * the retired native path, the primary invokes a SWARM command rather than a
 * CLI subagent. A no-op when delegation isn't enabled for this project/phase/CLI.
 */
export function configureDelegationRun(
	options: RunAgentCliOptions,
	context: DelegationRunContext,
): RunAgentCliOptions {
	if (!delegationEnabled(context.project, context.phase, options.cli)) return options;
	const policy = context.project.agents?.delegation;
	if (!policy) return options;
	const childCli = options.cli;
	const parentEnv = options.env ?? {};
	return {
		...options,
		env: {
			...parentEnv,
			[DELEGATION_ENV.childCli]: childCli,
			[DELEGATION_ENV.childModel]: resolveChildModel(policy, childCli),
			[DELEGATION_ENV.minimumOperations]: String(policy.minimumSemanticOperations),
			[DELEGATION_ENV.parentRunId]: context.runId ?? '',
			[DELEGATION_ENV.phase]: context.phase,
			[DELEGATION_ENV.command]:
				parentEnv[DELEGATION_ENV.command] ??
				process.env[DELEGATION_ENV.command] ??
				DEFAULT_DELEGATE_COMMAND,
		},
	};
}

export function delegationGuardLines(enabled: boolean): readonly string[] {
	if (!enabled) {
		return ['Do NOT spawn subagents. No curated delegation is enabled for this project and phase.'];
	}
	return [
		'Do NOT spawn CLI subagents, skills, or nested agents of any kind. Curated delegation of',
		'substantial, bounded documentation editing — whose facts and placement you have already',
		'decided — is available only through the SWARM-orchestrated child command, never a subagent:',
		`  1. Write the delegation contract as JSON to a \`.swarm-delegation-<id>.contract.json\` file:`,
		'     exact task and decidedFacts; allowedPaths; prohibitedScope; expectedArtifact;',
		'     verification command/evidence; reviewRequired:true; estimatedSemanticOperations;',
		`     delegationType:"documentation-edit"; agent:"${CURATED_DOCUMENTATION_AGENT}"; version:1.`,
		`  2. Run \`$${DELEGATION_ENV.command} <that-file>\`. SWARM launches a lighter-model child,`,
		`     pinned and sandboxed to a ${DELEGATION_CHILD_MAX_TURNS}-turn budget, in this worktree.`,
		'  3. Inspect the diff the command prints, accept or rework it yourself, run verification',
		`     yourself, and write \`${DELEGATION_REVIEW_FILENAME}\` with`,
		'     `{ "delegations": [{ "invocationId", "contractId", "disposition": "accepted"|"reworked", "note" }] }`.',
		'Do not delegate below the configured minimum semantic operations. Never delegate architecture',
		'or design decisions, ambiguous requirements, migrations, security/concurrency reasoning, broad',
		'refactors, commit/push/PR/review/comment/board mutation, formatting-only work, prescribed',
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
