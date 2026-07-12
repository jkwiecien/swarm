import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { getPersonaToken } from '../config/provider.js';
import type { ProjectConfig } from '../config/schema.js';
import {
	type AgentCli,
	type AgentCliResult,
	describeAgent,
	runAgentCli,
} from '../harness/agent-cli.js';
import { agentRunError } from '../harness/agent-failure.js';
import { logger } from '../lib/logger.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import { graftEnvironment } from '../worktree/graft.js';
import { GH_IDENTITY_GUARD } from './agent-auth.js';
import { PIPELINE_PHASE_GUARD } from './agent-scope.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	sessionRunArgs,
	shouldPreserveForResume,
} from './resume.js';

export const RESOLVE_CONFLICTS_OUTCOME_FILENAME = 'resolve_conflicts_outcome.json';
export const ResolveConflictsOutcomeSchema = z.object({
	status: z.literal('resolved'),
	mergeCommitSha: z.string().min(7),
});
export type ResolveConflictsOutcome = z.infer<typeof ResolveConflictsOutcomeSchema>;

export interface RunResolveConflictsPhaseOptions {
	project: ProjectConfig;
	prNumber: string;
	prBranch: string;
	headSha: string;
	baseBranch: string;
	baseSha: string;
	taskId: string;
	cli?: AgentCli;
	model?: string;
	/** Assign a fresh session id (`sessionId`) or resume from one on retry (`resumeSessionId`). */
	sessionId?: string;
	resumeSessionId?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	worktrees?: GitWorktreeManager;
	runAgent?: typeof runAgentCli;
	graft?: typeof graftEnvironment;
	getToken?: typeof getPersonaToken;
}

export function buildResolveConflictsPrompt(
	input: Pick<
		RunResolveConflictsPhaseOptions,
		'project' | 'prNumber' | 'prBranch' | 'headSha' | 'baseBranch' | 'baseSha'
	>,
): string {
	return [
		'You are the implementer assigned only to SWARM’s Resolve Conflicts phase.',
		GH_IDENTITY_GUARD,
		PIPELINE_PHASE_GUARD,
		`PR #${input.prNumber} in ${input.project.repo} has confirmed merge conflicts.`,
		`Its branch is "${input.prBranch}" and the observed head was ${input.headSha}. The current base is "${input.baseBranch}" at ${input.baseSha}.`,
		'Fetch origin. Before changing anything, verify origin/' +
			input.prBranch +
			' is still exactly ' +
			input.headSha +
			'; if not, stop and fail without pushing.',
		`Merge origin/${input.baseBranch} into the checked-out PR branch with a normal merge (never rebase and never force-push). Resolve every conflict while preserving both changes' intent.`,
		'Run the relevant lint, type-check, and tests. Commit the resolution as a merge commit and push normally. Re-check the remote head immediately before pushing; if it changed from the observed head, stop without pushing.',
		`Post one concise result comment on PR #${input.prNumber}.`,
		`Finally write ${RESOLVE_CONFLICTS_OUTCOME_FILENAME} at the worktree root as JSON: {"status":"resolved","mergeCommitSha":"<full sha>"}.`,
	].join('\n\n');
}

export async function runResolveConflictsPhase(
	options: RunResolveConflictsPhaseOptions,
): Promise<{ agent: AgentCliResult; outcome: ResolveConflictsOutcome }> {
	const {
		project,
		prNumber,
		prBranch,
		headSha,
		baseBranch,
		baseSha,
		taskId,
		cli = 'claude',
		model,
		sessionId,
		resumeSessionId,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
		getToken = getPersonaToken,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);
	logger.info(`Phase started - Resolve-conflicts — running ${describeAgent(cli, model)}`, {
		taskId,
		prNumber,
		headSha,
		baseSha,
	});
	const token = await getToken(project, 'implementer');
	// On a resume retry, reuse the preserved checkout so a partial merge resolution
	// and the agent's session carry over.
	const { handle, resumed } = await acquireResumableWorktree(
		worktrees,
		taskId,
		prBranch,
		false,
		resumeSessionId,
		() => worktrees.provision(taskId, { createBranch: false, branch: prBranch }),
	);
	let preserveForResume = false;
	try {
		graft(project.repoRoot, handle.path);
		const agent = await runAgent({
			cli,
			model,
			...sessionRunArgs({ sessionId, resumeSessionId }, resumed),
			cwd: handle.path,
			args: [
				buildResolveConflictsPrompt({ project, prNumber, prBranch, headSha, baseBranch, baseSha }),
			],
			env: { GH_TOKEN: token },
			maxOutputBytes: 1_000_000,
			logContext: { taskId, phase: 'resolve-conflicts', prNumber, headSha, baseSha },
			timeoutMs,
			signal,
		});
		if (agent.exitCode !== 0) {
			const error = agentRunError(
				agent,
				`Resolve-conflicts agent (${cli}) exited with code ${agent.exitCode}`,
				` for PR #${prNumber}`,
			);
			preserveForResume = shouldPreserveForResume(error);
			throw error;
		}
		const path = join(handle.path, RESOLVE_CONFLICTS_OUTCOME_FILENAME);
		if (!existsSync(path))
			throw new Error(
				`Resolve-conflicts agent did not write ${RESOLVE_CONFLICTS_OUTCOME_FILENAME}`,
			);
		const outcome = ResolveConflictsOutcomeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
		logger.info('Phase finished - Resolve-conflicts', { taskId, prNumber, ...outcome });
		return { agent, outcome };
	} finally {
		await cleanupUnlessPreserved(worktrees, taskId, preserveForResume, 'resolve-conflicts phase');
	}
}
