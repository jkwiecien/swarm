import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import type { ProvisionOptions, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import {
	createMockGitHubProjectsWebhookJob,
	createMockGitHubWebhookJob,
	createMockProjectConfig,
} from '../../helpers/factories.js';

// Every collaborator is mocked at the module boundary (ai/TESTING.md): the
// mock factories close over `let` implementations swapped per test, and
// `calls` records invocation order — the wiring under test *is* the order
// provision → graft → run → cleanup.
const calls: string[] = [];

let projectLookup: (id: string) => ProjectConfig | undefined;
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByIdFromDb: async (id: string) => projectLookup(id),
}));

let provisionImpl: (taskId: string, options?: ProvisionOptions) => Promise<WorktreeHandle>;
let cleanupImpl: (taskId: string) => Promise<void>;
const provisionCalls: Array<{ taskId: string; options?: ProvisionOptions }> = [];
const cleanupCalls: string[] = [];
const constructedWith: ProjectConfig[] = [];
vi.mock('@/worker/git-worktree-manager.js', () => ({
	GitWorktreeManager: class {
		constructor(project: ProjectConfig) {
			constructedWith.push(project);
		}
		provision(taskId: string, options?: ProvisionOptions): Promise<WorktreeHandle> {
			calls.push('provision');
			provisionCalls.push({ taskId, options });
			return provisionImpl(taskId, options);
		}
		cleanup(taskId: string): Promise<void> {
			calls.push('cleanup');
			cleanupCalls.push(taskId);
			return cleanupImpl(taskId);
		}
	},
}));

let graftImpl: (repoRoot: string, worktreeDir: string) => unknown;
const graftCalls: Array<{ repoRoot: string; worktreeDir: string }> = [];
vi.mock('@/worktree/graft.js', () => ({
	graftEnvironment: (repoRoot: string, worktreeDir: string) => {
		calls.push('graft');
		graftCalls.push({ repoRoot, worktreeDir });
		return graftImpl(repoRoot, worktreeDir);
	},
}));

let runImpl: (options: RunAgentCliOptions) => Promise<AgentCliResult>;
const runCalls: RunAgentCliOptions[] = [];
vi.mock('@/harness/agent-cli.js', () => ({
	runAgentCli: (options: RunAgentCliOptions) => {
		calls.push('run');
		runCalls.push(options);
		return runImpl(options);
	},
}));

import { createTriggerRegistry } from '@/triggers/registry.js';
import type { TriggerContext, TriggerResult } from '@/triggers/types.js';
import { MAX_AGENT_OUTPUT_BYTES, processJob } from '@/worker/consumer.js';

const PROJECT = createMockProjectConfig();
const HANDLE: WorktreeHandle = {
	taskId: '17',
	path: `${PROJECT.repoRoot}/.swarm-workspaces/task-17`,
	branch: 'issue-17',
};

function agentResult(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 1234,
		timedOut: false,
		outputTruncated: false,
		...overrides,
	};
}

function registryReturning(result: TriggerResult | null, seenContexts: TriggerContext[] = []) {
	const registry = createTriggerRegistry();
	registry.register({
		name: 'test-trigger',
		description: 'returns a fixed result',
		matches: () => true,
		handle: async (ctx) => {
			seenContexts.push(ctx);
			return result;
		},
	});
	return registry;
}

describe('processJob', () => {
	beforeEach(() => {
		calls.length = 0;
		provisionCalls.length = 0;
		cleanupCalls.length = 0;
		constructedWith.length = 0;
		graftCalls.length = 0;
		runCalls.length = 0;
		projectLookup = () => PROJECT;
		provisionImpl = async () => HANDLE;
		cleanupImpl = async () => undefined;
		graftImpl = () => [];
		runImpl = async () => agentResult();
	});

	it('throws for a job referencing an unknown project', async () => {
		projectLookup = () => undefined;

		await expect(
			processJob(createMockGitHubWebhookJob({ projectId: 'ghost' }), registryReturning(null)),
		).rejects.toThrow("unknown project 'ghost'");
		expect(calls).toEqual([]);
	});

	it('completes as no-trigger without touching worktrees', async () => {
		const registry = createTriggerRegistry();

		await expect(processJob(createMockGitHubWebhookJob(), registry)).resolves.toEqual({
			status: 'no-trigger',
		});
		expect(calls).toEqual([]);
	});

	it('hands the trigger a context built from the job', async () => {
		const seen: TriggerContext[] = [];
		const job = createMockGitHubWebhookJob();

		await processJob(job, registryReturning(null, seen));

		expect(seen).toEqual([
			{
				project: PROJECT,
				deliveryId: job.deliveryId,
				source: 'github',
				event: job.event,
			},
		]);
	});

	it('discriminates the context source for a projects job', async () => {
		const seen: TriggerContext[] = [];
		const job = createMockGitHubProjectsWebhookJob();

		await processJob(job, registryReturning(null, seen));

		expect(seen[0].source).toBe('github-projects');
		expect(seen[0].event).toEqual(job.event);
	});

	it('wires provision → graft → run → cleanup for a matched trigger', async () => {
		const trigger: TriggerResult = {
			taskId: '17',
			cli: 'claude',
			args: ['-p', 'implement the plan'],
			env: { SWARM_PHASE: 'implementation' },
			worktree: { branch: 'issue-17-consumer', baseBranch: 'main' },
			timeoutMs: 60_000,
		};

		const outcome = await processJob(createMockGitHubWebhookJob(), registryReturning(trigger));

		expect(calls).toEqual(['provision', 'graft', 'run', 'cleanup']);
		expect(constructedWith).toEqual([PROJECT]);
		expect(provisionCalls).toEqual([{ taskId: '17', options: trigger.worktree }]);
		expect(graftCalls).toEqual([{ repoRoot: PROJECT.repoRoot, worktreeDir: HANDLE.path }]);
		expect(runCalls).toEqual([
			{
				cli: 'claude',
				cwd: HANDLE.path,
				args: trigger.args,
				env: trigger.env,
				timeoutMs: trigger.timeoutMs,
				maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
			},
		]);
		expect(cleanupCalls).toEqual(['17']);
		expect(outcome).toEqual({
			status: 'agent-succeeded',
			taskId: HANDLE.taskId,
			branch: HANDLE.branch,
			exitCode: 0,
			signal: null,
			timedOut: false,
			durationMs: 1234,
		});
	});

	it('threads the shutdown signal through to the agent run', async () => {
		const controller = new AbortController();

		await processJob(
			createMockGitHubWebhookJob(),
			registryReturning({ taskId: '17', cli: 'claude' }),
			controller.signal,
		);

		expect(runCalls).toHaveLength(1);
		expect(runCalls[0].signal).toBe(controller.signal);
	});

	it('reports a non-zero agent exit as agent-failed, not an error', async () => {
		runImpl = async () => agentResult({ exitCode: 3 });

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning({ taskId: '17', cli: 'claude' }),
		);

		expect(outcome.status).toBe('agent-failed');
		expect(calls).toEqual(['provision', 'graft', 'run', 'cleanup']);
	});

	it('cleans up the worktree when the agent run rejects', async () => {
		runImpl = async () => {
			throw new Error('claude is not installed');
		};

		await expect(
			processJob(createMockGitHubWebhookJob(), registryReturning({ taskId: '17', cli: 'claude' })),
		).rejects.toThrow('claude is not installed');
		expect(cleanupCalls).toEqual(['17']);
	});

	it('cleans up the worktree when grafting throws', async () => {
		graftImpl = () => {
			throw new Error('repoRoot must be absolute');
		};

		await expect(
			processJob(createMockGitHubWebhookJob(), registryReturning({ taskId: '17', cli: 'claude' })),
		).rejects.toThrow('repoRoot must be absolute');
		expect(calls).toEqual(['provision', 'graft', 'cleanup']);
	});

	it('does not let a cleanup failure mask a successful run', async () => {
		cleanupImpl = async () => {
			throw new Error('worktree locked');
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning({ taskId: '17', cli: 'claude' }),
		);

		expect(outcome.status).toBe('agent-succeeded');
	});

	it('propagates a provisioning failure without running the agent', async () => {
		provisionImpl = async () => {
			throw new Error('worktree already exists');
		};

		await expect(
			processJob(createMockGitHubWebhookJob(), registryReturning({ taskId: '17', cli: 'claude' })),
		).rejects.toThrow('worktree already exists');
		expect(calls).toEqual(['provision']);
	});
});
