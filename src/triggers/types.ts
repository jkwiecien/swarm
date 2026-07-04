/**
 * Trigger types — how the worker decides *what* to do with a dequeued event,
 * mirroring Cascade's `src/triggers/types.ts` + `src/types` trigger interfaces.
 * One deliberate deviation: Cascade dispatches triggers router-side and ships
 * the result in the job; SWARM's worker owns the lookup (ai/ARCHITECTURE.md
 * "Components" — the worker "looks up the trigger handler for the event"), so
 * the job carries only the parsed event and the context is rebuilt here.
 *
 * A `TriggerResult` describes an agent run in the worker's own vocabulary — the
 * worktree to provision (SWARM-14) and the agent CLI to launch in it (SWARM-16).
 * These are in-process shapes (the queue boundary is `src/queue/jobs.ts`), so
 * plain interfaces, not Zod.
 */

import type { ProjectConfig } from '../config/schema.js';
import type { AgentCli } from '../harness/agent-cli.js';
import type { GitHubParsedEvent } from '../router/adapters/github.js';
import type { GitHubProjectsParsedEvent } from '../router/adapters/github-projects.js';
import type { ProvisionOptions } from '../worker/git-worktree-manager.js';

/**
 * What a trigger handler sees: the resolved project plus the parsed event,
 * discriminated by which router adapter produced it.
 */
export type TriggerContext = {
	project: ProjectConfig;
	/** GitHub's `X-GitHub-Delivery`, when the job carried one. */
	deliveryId?: string;
} & (
	| { source: 'github'; event: GitHubParsedEvent }
	| { source: 'github-projects'; event: GitHubProjectsParsedEvent }
);

export type TriggerSource = TriggerContext['source'];

/** An agent run for the worker to execute: worktree in, agent CLI on top. */
export interface TriggerResult {
	/**
	 * Task identifier the worktree is provisioned under (usually the issue/PR
	 * number) — becomes `task-<id>` in the worktree path and the default branch
	 * suffix (`GitWorktreeManager`).
	 */
	taskId: string;
	/** Which agent CLI to launch in the worktree. */
	cli: AgentCli;
	/** Arguments passed to the CLI (prompt, flags, …). */
	args?: string[];
	/** Extra env vars for the CLI process. */
	env?: Record<string, string>;
	/** Worktree provisioning options (branch, createBranch, baseBranch, fetch). */
	worktree?: ProvisionOptions;
	/** Kill the agent run if it exceeds this many ms. */
	timeoutMs?: number;
}

export interface TriggerHandler {
	name: string;
	description: string;
	matches(ctx: TriggerContext): boolean;
	handle(ctx: TriggerContext): Promise<TriggerResult | null>;
}
