import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError } from '@/harness/agent-failure.js';
import type { PMProvider } from '@/pm/types.js';
import { WorktreeAlreadyExistsError } from '@/worker/git-worktree-manager.js';
import {
	createMockGitHubParsedEvent,
	createMockGitHubProjectsWebhookJob,
	createMockGitHubWebhookJob,
	createMockProjectConfig,
	createMockWorkItem,
} from '../../helpers/factories.js';

// Every collaborator is mocked at the module boundary (ai/TESTING.md). The
// consumer no longer owns the worktree lifecycle — each pipeline phase does —
// so this mocks the four phase orchestrators + the PM-provider factory and
// asserts the wiring: which phase runs, with which inputs, and how its result
// (or failure) becomes a JobOutcome.

let projectLookup: (id: string) => ProjectConfig | undefined;
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByIdFromDb: async (id: string) => projectLookup(id),
}));

const addComment = vi.fn(async (_id: string, _text: string) => 'comment-1');
const provider = { type: 'github-projects', addComment } as unknown as PMProvider;
const providerBuiltWith: ProjectConfig[] = [];
vi.mock('@/integrations/pm/github-projects/provider.js', () => ({
	createGitHubProjectsProvider: (project: ProjectConfig) => {
		providerBuiltWith.push(project);
		return provider;
	},
}));

type PhaseCall = { phase: string; args: Record<string, unknown> };
const phaseCalls: PhaseCall[] = [];
let phaseImpl: (
	phase: string,
	args: Record<string, unknown>,
) => Promise<{
	agent: AgentCliResult;
	movedTo?: string;
	split?: { subTaskItemIds: string[]; mainTaskUpdated: boolean };
}>;

function mockPhase(phase: string) {
	return (args: Record<string, unknown>) => {
		phaseCalls.push({ phase, args });
		return phaseImpl(phase, args);
	};
}
vi.mock('@/pipeline/planning.js', () => ({ runPlanningPhase: mockPhase('planning') }));
vi.mock('@/pipeline/implementation.js', () => ({
	runImplementationPhase: mockPhase('implementation'),
}));
vi.mock('@/pipeline/review.js', () => ({ runReviewPhase: mockPhase('review') }));
vi.mock('@/pipeline/respond-to-review.js', () => ({
	runRespondToReviewPhase: mockPhase('respond-to-review'),
}));

const enqueueJob = vi.fn(async (_job: unknown) => 'synthetic-job-1');
vi.mock('@/queue/producer.js', () => ({
	enqueueJob: (job: unknown) => enqueueJob(job),
}));

// The run-history repository is mocked at the module boundary: these assertions
// pin the best-effort run-row lifecycle (create before the phase, finalize after)
// without a live Postgres. `createRun` resolves a fixed id the completion sites
// finalize against.
const createRun = vi.fn(async (_input: unknown) => 'run-1');
const completeRun = vi.fn(async (_id: string, _input: unknown) => {});
const storeRunLogs = vi.fn(async (_id: string, _stdout: string, _stderr: string) => {});
vi.mock('@/db/repositories/runsRepository.js', () => ({
	createRun: (input: unknown) => createRun(input),
	completeRun: (id: string, input: unknown) => completeRun(id, input),
	storeRunLogs: (id: string, stdout: string, stderr: string) => storeRunLogs(id, stdout, stderr),
}));

// Global (app-wide) settings are loaded once per job for the default-model tier
// (`resolveModel`). Mocked at the module boundary so these tests drive the
// global `agents.defaults` without a live Postgres; defaults to "nothing stored".
const getAppSettings = vi.fn(async () => ({}) as Record<string, unknown>);
vi.mock('@/db/repositories/appSettingsRepository.js', () => ({
	getAppSettings: () => getAppSettings(),
}));

// The PR-comment path of `reportInterruptedJobToBoard` goes through the concrete
// SCM integration (the PM provider has no PR → comment mapping); mock it at the
// module boundary the same way the PM provider is mocked above.
const commentOnPullRequest = vi.fn(async (_p: ProjectConfig, _n: number, _b: string) => 99);
vi.mock('@/integrations/scm/github/scm-integration.js', () => ({
	GitHubSCMIntegration: class {
		commentOnPullRequest = commentOnPullRequest;
	},
}));

import { createTriggerRegistry } from '@/triggers/registry.js';
import type { TriggerContext, TriggerResult } from '@/triggers/types.js';
import { processJob, reportInterruptedJobToBoard } from '@/worker/consumer.js';

const PROJECT = createMockProjectConfig();

function agentResult(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 1234,
		timedOut: false,
		aborted: false,
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

const REVIEW_TRIGGER: TriggerResult = {
	phase: 'review',
	taskId: '17',
	prNumber: '17',
	headSha: 'deadbeef',
};

describe('processJob', () => {
	beforeEach(() => {
		phaseCalls.length = 0;
		providerBuiltWith.length = 0;
		projectLookup = () => PROJECT;
		phaseImpl = async () => ({ agent: agentResult() });
		addComment.mockClear();
		addComment.mockResolvedValue('comment-1');
		enqueueJob.mockClear();
		enqueueJob.mockResolvedValue('synthetic-job-1');
		createRun.mockClear();
		createRun.mockResolvedValue('run-1');
		completeRun.mockClear();
		completeRun.mockResolvedValue(undefined);
		storeRunLogs.mockClear();
		storeRunLogs.mockResolvedValue(undefined);
		getAppSettings.mockClear();
		getAppSettings.mockResolvedValue({});
	});

	it('throws for a job referencing an unknown project', async () => {
		projectLookup = () => undefined;

		await expect(
			processJob(createMockGitHubWebhookJob({ projectId: 'ghost' }), registryReturning(null)),
		).rejects.toThrow("unknown project 'ghost'");
		expect(phaseCalls).toEqual([]);
	});

	it('completes as no-trigger without running a phase', async () => {
		const registry = createTriggerRegistry();

		await expect(processJob(createMockGitHubWebhookJob(), registry)).resolves.toEqual({
			status: 'no-trigger',
		});
		expect(phaseCalls).toEqual([]);
	});

	it('hands the trigger a context built from the job', async () => {
		const seen: TriggerContext[] = [];
		const job = createMockGitHubWebhookJob();

		await processJob(job, registryReturning(null, seen));

		expect(seen).toEqual([
			{ project: PROJECT, deliveryId: job.deliveryId, source: 'github', event: job.event },
		]);
	});

	it('threads a recheck job back through, exposing its incremented recheckAttempt to the trigger', async () => {
		// A deferred recheck (scheduleCoalescedJob) re-enqueues the same event with
		// recheckAttempt bumped; when the worker pulls it, processJob must surface
		// that attempt in the ctx so the review handler re-matches and can enforce
		// its recheck cap rather than looping forever.
		const seen: TriggerContext[] = [];
		const job = createMockGitHubWebhookJob({ recheckAttempt: 5 });

		await processJob(job, registryReturning(REVIEW_TRIGGER, seen));

		expect(seen[0].recheckAttempt).toBe(5);
		expect(phaseCalls[0].phase).toBe('review');
	});

	it('threads a deferred PM phase through so its status trigger can resume it', async () => {
		const seen: TriggerContext[] = [];
		const job = createMockGitHubProjectsWebhookJob({ resumePmPhase: 'implementation' });

		await processJob(job, registryReturning(null, seen));

		expect(seen[0].resumePmPhase).toBe('implementation');
	});

	it('reuses the implementation branch for a resumed PM implementation', async () => {
		const workItem = createMockWorkItem({ statusId: '47fc9ee4' });
		const trigger: TriggerResult = { phase: 'implementation', taskId: '10', workItem };

		await processJob(
			createMockGitHubProjectsWebhookJob({ resumePmPhase: 'implementation' }),
			registryReturning(trigger),
		);

		expect(phaseCalls[0].args.resumeExistingBranch).toBe(true);
	});

	it('discriminates the context source for a projects job', async () => {
		const seen: TriggerContext[] = [];
		const job = createMockGitHubProjectsWebhookJob();

		await processJob(job, registryReturning(null, seen));

		expect(seen[0].source).toBe('github-projects');
		expect(seen[0].event).toEqual(job.event);
	});

	it('runs the Review phase for a review trigger and maps the outcome', async () => {
		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(phaseCalls).toHaveLength(1);
		expect(phaseCalls[0].phase).toBe('review');
		expect(phaseCalls[0].args).toMatchObject({
			project: PROJECT,
			prNumber: '17',
			headSha: 'deadbeef',
			taskId: '17',
		});
		expect(outcome).toEqual({
			status: 'phase-succeeded',
			phase: 'review',
			taskId: '17',
			exitCode: 0,
			signal: null,
			timedOut: false,
			durationMs: 1234,
		});
	});

	it('builds a PM provider and passes the work item for a planning trigger', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(providerBuiltWith).toEqual([PROJECT]);
		expect(phaseCalls[0].phase).toBe('planning');
		expect(phaseCalls[0].args).toMatchObject({
			project: PROJECT,
			taskId: '10',
			workItem,
			pm: provider,
		});
	});

	describe('self-enqueue after auto-advance', () => {
		it('self-enqueues Planning for every newly created split child', async () => {
			const trigger: TriggerResult = {
				phase: 'planning',
				taskId: '10',
				workItem: createMockWorkItem(),
			};
			phaseImpl = async () => ({
				agent: agentResult(),
				split: {
					subTaskItemIds: ['PVTI_child-one', 'PVTI_child-two'],
					mainTaskUpdated: true,
				},
			});

			await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

			expect(enqueueJob).toHaveBeenCalledTimes(2);
			for (const itemNodeId of ['PVTI_child-one', 'PVTI_child-two']) {
				expect(enqueueJob).toHaveBeenCalledWith({
					type: 'github-projects',
					projectId: PROJECT.id,
					event: {
						eventType: 'projects_v2_item',
						action: 'edited',
						itemNodeId,
						projectNodeId: PROJECT.githubProjects.projectId,
						changedFieldNodeId: PROJECT.githubProjects.statusFieldId,
						changedFieldType: 'single_select',
					},
				});
			}
		});

		it('self-enqueues a synthetic board job when Planning auto-advances to ToDo', async () => {
			const workItem = createMockWorkItem({ statusId: '3fe662f4' });
			const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };
			phaseImpl = async () => ({ agent: agentResult(), movedTo: 'todo' });

			await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

			expect(enqueueJob).toHaveBeenCalledExactlyOnceWith({
				type: 'github-projects',
				projectId: PROJECT.id,
				event: {
					eventType: 'projects_v2_item',
					action: 'edited',
					itemNodeId: workItem.id,
					projectNodeId: PROJECT.githubProjects.projectId,
					changedFieldNodeId: PROJECT.githubProjects.statusFieldId,
					changedFieldType: 'single_select',
				},
			});
		});

		it('does not self-enqueue when the phase made no move (autoAdvance off)', async () => {
			const trigger: TriggerResult = {
				phase: 'planning',
				taskId: '10',
				workItem: createMockWorkItem(),
			};
			phaseImpl = async () => ({ agent: agentResult() });

			await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

			expect(enqueueJob).not.toHaveBeenCalled();
		});

		it("does not self-enqueue when the destination status doesn't start a phase", async () => {
			const trigger: TriggerResult = {
				phase: 'implementation',
				taskId: '10',
				workItem: createMockWorkItem(),
			};
			// Implementation's own report-back move (to "inReview") isn't a trigger.
			phaseImpl = async () => ({ agent: agentResult(), movedTo: 'inReview' });

			await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

			expect(enqueueJob).not.toHaveBeenCalled();
		});

		it('does not self-enqueue for a non-PM (PR-driven) phase', async () => {
			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(enqueueJob).not.toHaveBeenCalled();
		});

		it('still reports phase-succeeded when the self-enqueue itself fails', async () => {
			const trigger: TriggerResult = {
				phase: 'planning',
				taskId: '10',
				workItem: createMockWorkItem(),
			};
			phaseImpl = async () => ({ agent: agentResult(), movedTo: 'todo' });
			enqueueJob.mockRejectedValueOnce(new Error('redis unreachable'));

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(trigger),
			);

			expect(outcome.status).toBe('phase-succeeded');
		});
	});

	it("threads the project's per-phase agent override (cli/model) into the phase call", async () => {
		const projectWithAgents = createMockProjectConfig({
			agents: { planning: { cli: 'antigravity', model: 'Gemini 3.5 Flash (High)' } },
		});
		projectLookup = () => projectWithAgents;
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args).toMatchObject({
			cli: 'antigravity',
			model: 'Gemini 3.5 Flash (High)',
		});
	});

	it('passes undefined cli and the default model when the project has no agents override, leaving phase on coded default CLI but resolving default model', async () => {
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.cli).toBeUndefined();
		expect(phaseCalls[0].args.model).toBe('sonnet');
	});

	it('resolves model to the project defaults block when phase override omits model', async () => {
		const projectWithDefaults = createMockProjectConfig({
			agents: {
				defaults: { claude: 'opus' },
				planning: { cli: 'claude' },
			},
		});
		projectLookup = () => projectWithDefaults;
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.cli).toBe('claude');
		expect(phaseCalls[0].args.model).toBe('opus');
	});

	it('resolves model to the global defaults when the project has none', async () => {
		getAppSettings.mockResolvedValue({ agents: { defaults: { claude: 'opus' } } });
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		// No project override at all → the global default wins over the coded default.
		expect(phaseCalls[0].args.model).toBe('opus');
	});

	it('prefers the project default over the global default', async () => {
		getAppSettings.mockResolvedValue({ agents: { defaults: { claude: 'haiku' } } });
		const projectWithDefaults = createMockProjectConfig({
			agents: { defaults: { claude: 'opus' }, planning: { cli: 'claude' } },
		});
		projectLookup = () => projectWithDefaults;
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.model).toBe('opus');
	});

	it('prefers the per-phase model over both project and global defaults', async () => {
		getAppSettings.mockResolvedValue({ agents: { defaults: { claude: 'haiku' } } });
		const projectWithDefaults = createMockProjectConfig({
			agents: {
				defaults: { claude: 'opus' },
				planning: { cli: 'claude', model: 'sonnet' },
			},
		});
		projectLookup = () => projectWithDefaults;
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.model).toBe('sonnet');
	});

	it('falls back to the coded default when neither project nor global sets one', async () => {
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.model).toBe('sonnet');
	});

	it('still runs the phase on coded defaults when the settings load fails', async () => {
		getAppSettings.mockRejectedValueOnce(new Error('db down'));
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning(trigger),
		);

		expect(outcome.status).toBe('phase-succeeded');
		expect(phaseCalls[0].args.model).toBe('sonnet');
	});

	it("threads the project's per-phase autoAdvance setting into planning and implementation calls", async () => {
		const projectWithPipeline = createMockProjectConfig({
			pipeline: { planning: { autoAdvance: true }, implementation: { autoAdvance: false } },
		});
		projectLookup = () => projectWithPipeline;

		await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({
				phase: 'planning',
				taskId: '10',
				workItem: createMockWorkItem({ statusId: '61e4505c' }),
			}),
		);
		expect(phaseCalls[0].args.autoAdvance).toBe(true);

		phaseCalls.length = 0;
		await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({
				phase: 'implementation',
				taskId: '10',
				workItem: createMockWorkItem({ statusId: '3121a97d' }),
			}),
		);
		expect(phaseCalls[0].args.autoAdvance).toBe(false);
	});

	it('passes undefined autoAdvance when the project has no pipeline override, leaving each phase on its coded default', async () => {
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.autoAdvance).toBeUndefined();
	});

	it('threads the shutdown signal through to the phase', async () => {
		const controller = new AbortController();

		await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
			controller.signal,
		);

		expect(phaseCalls[0].args.signal).toBe(controller.signal);
	});

	it('reports a phase failure as phase-failed, not a thrown error', async () => {
		phaseImpl = async () => {
			throw new Error('review agent exited with code 3');
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome).toEqual({
			status: 'phase-failed',
			phase: 'review',
			taskId: '17',
			error: 'review agent exited with code 3',
		});
	});

	it('posts a failure comment on the backing issue when a work-item phase fails terminally', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new Error("implementation agent (antigravity) exited with code 1 for task '100'");
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledTimes(1);
		const [itemId, body] = addComment.mock.calls[0];
		expect(itemId).toBe(workItem.id);
		expect(body).toContain('SWARM run failed');
		expect(body).toContain('**implementation**');
		expect(body).toContain("exited with code 1 for task '100'");
		expect(body).not.toContain('splitting the issue');
	});

	it('posts a failure comment with splitting suggestion for stalled agent runs', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError('stalled', { kind: 'stalled' });
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledTimes(1);
		const [, body] = addComment.mock.calls[0];
		expect(body).toContain('splitting the issue');
	});

	it('posts a failure comment with splitting suggestion for timeout agent runs', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError('timeout', { kind: 'timeout' });
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledTimes(1);
		const [, body] = addComment.mock.calls[0];
		expect(body).toContain('splitting the issue');
	});

	it('does not append splitting suggestion for a non-stalled AgentRunError', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError('some other agent failure', { kind: 'error' });
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledTimes(1);
		const [, body] = addComment.mock.calls[0];
		expect(body).not.toContain('splitting the issue');
	});

	it('does not comment on a deferred (rate-limited) failure — the run will retry', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError('rate limited', { kind: 'rate-limit' });
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-deferred');
		expect(addComment).not.toHaveBeenCalled();
	});

	it('does not comment for a PR-driven phase failure (no backing work item)', async () => {
		phaseImpl = async () => {
			throw new Error('review agent exited with code 3');
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).not.toHaveBeenCalled();
	});

	it('still reports phase-failed when the failure comment itself fails to post', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		addComment.mockRejectedValue(new Error('github 502'));
		phaseImpl = async () => {
			throw new Error('implementation agent exited with code 1');
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledTimes(1);
	});

	it('defers a rate-limited phase instead of failing it, delaying until after the reset', async () => {
		const retryAfter = new Date(Date.now() + 90 * 60 * 1000); // 90 min out
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 1 (rate limited)', {
				kind: 'rate-limit',
				resetHint: '1:40pm (Europe/Warsaw)',
				retryAfter,
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-deferred');
		if (outcome.status !== 'phase-deferred') throw new Error('unreachable');
		expect(outcome.phase).toBe('review');
		expect(outcome.taskId).toBe('17');
		expect(outcome.attempt).toBe(0);
		// ~90 min + a small buffer, comfortably inside the [6min, 6h] clamp.
		expect(outcome.retryDelayMs).toBeGreaterThan(90 * 60 * 1000);
		expect(outcome.retryDelayMs).toBeLessThan(92 * 60 * 1000);
	});

	it('floors the retry delay above the review-dispatch-dedup TTL even for an imminent reset', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('rate limited', {
				kind: 'rate-limit',
				retryAfter: new Date(Date.now() + 1000), // resets ~now
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
		expect(outcome.retryDelayMs).toBeGreaterThanOrEqual(6 * 60 * 1000);
	});

	it('falls back to a default delay when the limit gave no parseable reset time', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('rate limited', { kind: 'rate-limit' });
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
		expect(outcome.retryDelayMs).toBe(30 * 60 * 1000);
	});

	it('fails a rate-limited phase once the retry budget is exhausted', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 1 (rate limited)', {
				kind: 'rate-limit',
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob({ rateLimitRetryAttempt: 6 }),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome).toEqual({
			status: 'phase-failed',
			phase: 'review',
			taskId: '17',
			error: 'Review agent (claude) exited with code 1 (rate limited)',
		});
	});

	it('does not defer a non-rate-limit AgentRunError', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 1', { kind: 'error' });
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-failed');
	});

	it('defers an aborted phase (worker shutdown mid-run) with the dedup-safe floor delay', async () => {
		// A run the worker itself killed (e.g. a dev --watch restart) has no reset
		// hint — it must still land above the review-dispatch-dedup TTL, same as a
		// rate-limit retry, not the rate-limit path's 30-min no-hint default.
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 143 (aborted)', {
				kind: 'aborted',
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-deferred');
		if (outcome.status !== 'phase-deferred') throw new Error('unreachable');
		expect(outcome.attempt).toBe(0);
		expect(outcome.retryDelayMs).toBe(6 * 60 * 1000);
	});

	it('fails an aborted phase once the retry budget is exhausted', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 143 (aborted)', {
				kind: 'aborted',
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob({ rateLimitRetryAttempt: 6 }),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome).toEqual({
			status: 'phase-failed',
			phase: 'review',
			taskId: '17',
			error: 'Review agent (claude) exited with code 143 (aborted)',
		});
	});

	it('defers a worktree already exists error with the dedup-safe floor delay', async () => {
		phaseImpl = async () => {
			throw new WorktreeAlreadyExistsError('17', '/some/path');
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-deferred');
		if (outcome.status !== 'phase-deferred') throw new Error('unreachable');
		expect(outcome.attempt).toBe(0);
		expect(outcome.retryDelayMs).toBe(6 * 60 * 1000);
	});

	it('fails a worktree already exists error once retry budget is exhausted and comments on PR', async () => {
		phaseImpl = async () => {
			throw new WorktreeAlreadyExistsError('17', '/some/path');
		};

		commentOnPullRequest.mockClear();

		const outcome = await processJob(
			createMockGitHubWebhookJob({ rateLimitRetryAttempt: 6 }),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome).toEqual({
			status: 'phase-failed',
			phase: 'review',
			taskId: '17',
			error:
				"Worktree for task '17' already exists at /some/path — clean it up before re-provisioning",
		});
		expect(commentOnPullRequest).toHaveBeenCalledTimes(1);
		expect(commentOnPullRequest.mock.calls[0][1]).toBe(17);
		expect(commentOnPullRequest.mock.calls[0][2]).toContain(
			"Worktree for task '17' already exists",
		);
	});

	it('fails a worktree already exists error once retry budget is exhausted and comments on board for PM phase', async () => {
		const workItem = createMockWorkItem({ id: 'item-100' });
		phaseImpl = async () => {
			throw new WorktreeAlreadyExistsError('100', '/some/path');
		};

		addComment.mockClear();

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob({ rateLimitRetryAttempt: 6 }),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledTimes(1);
		expect(addComment.mock.calls[0][0]).toBe('item-100');
		expect(addComment.mock.calls[0][1]).toContain("Worktree for task '100' already exists");
	});

	describe('in-flight guard (duplicate-dispatch collision)', () => {
		// The bug: a duplicate `reordered`/`edited` webhook for the same card can be
		// dequeued after the pm-status dedup's TTL expired (having waited in the
		// queue behind long runs), re-dispatching the same phase for the same task
		// while the first run still holds the `task-<id>` worktree — the second
		// `provision()` then failed with "worktree already exists". The guard skips
		// the duplicate instead.

		it('skips a duplicate dispatch for a task already running here, without running the phase twice', async () => {
			// Park the first run's phase on a gate so it stays "in flight" while the
			// second job is processed.
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			phaseImpl = async () => {
				await gate;
				return { agent: agentResult() };
			};

			const first = processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
			// Let the first call get past its awaits (project lookup, dispatch) and into
			// runPhase, so it has registered taskId 17 as in-flight.
			await new Promise((r) => setTimeout(r, 0));

			const second = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(second).toEqual({ status: 'skipped-in-flight', phase: 'review', taskId: '17' });
			expect(phaseCalls).toHaveLength(1); // the phase ran once, not twice

			release?.();
			await first; // let the first run settle so it releases the slot before the next test
		});

		it('releases the slot after the phase settles, so a later dispatch for the same task runs', async () => {
			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
			expect(phaseCalls).toHaveLength(1);

			// Same taskId again, now that the first has finished — must not be skipped.
			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(phaseCalls).toHaveLength(2);
		});

		it('releases the slot even when the phase fails, so a retry for the same task can run', async () => {
			phaseImpl = async () => {
				throw new Error('boom');
			};
			const failed = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);
			expect(failed.status).toBe('phase-failed');

			phaseImpl = async () => ({ agent: agentResult() });
			const retried = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(retried.status).toBe('phase-succeeded');
		});

		it('does not block a different task from running concurrently', async () => {
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			phaseImpl = async (_phase, args) => {
				if (args.taskId === '17') await gate; // only task 17 parks
				return { agent: agentResult() };
			};

			const first = processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
			await new Promise((r) => setTimeout(r, 0));

			// A different taskId must run, not be skipped by task 17's in-flight slot.
			const other: TriggerResult = { ...REVIEW_TRIGGER, taskId: '18', prNumber: '18' };
			const second = await processJob(createMockGitHubWebhookJob(), registryReturning(other));

			expect(second.status).toBe('phase-succeeded');

			release?.();
			await first;
		});
	});

	describe('run-history tracking', () => {
		it('creates a run row then finalizes it completed with the agent result on success', async () => {
			phaseImpl = async () => ({
				agent: agentResult({
					exitCode: 0,
					timedOut: false,
					durationMs: 1234,
					stdout: 'o',
					stderr: 'e',
				}),
			});

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(createRun).toHaveBeenCalledExactlyOnceWith({
				projectId: PROJECT.id,
				taskId: '17',
				phase: 'review',
				workItemId: undefined,
				workItemTitle: undefined,
				workItemUrl: undefined,
				prNumber: '17',
				model: 'sonnet',
			});
			expect(completeRun).toHaveBeenCalledExactlyOnceWith('run-1', {
				status: 'completed',
				engine: 'claude',
				exitCode: 0,
				timedOut: false,
				durationMs: 1234,
			});
			expect(storeRunLogs).toHaveBeenCalledExactlyOnceWith('run-1', 'o', 'e');
		});

		it('records the work item metadata and requested model for a PM-driven phase', async () => {
			const projectWithAgents = createMockProjectConfig({
				agents: { planning: { cli: 'antigravity', model: 'Gemini 3.5 Flash (High)' } },
			});
			projectLookup = () => projectWithAgents;
			const workItem = createMockWorkItem({ statusId: '61e4505c' });

			await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning({ phase: 'planning', taskId: '10', workItem }),
			);

			expect(createRun).toHaveBeenCalledExactlyOnceWith({
				projectId: projectWithAgents.id,
				taskId: '10',
				phase: 'planning',
				workItemId: workItem.id,
				workItemTitle: workItem.title,
				workItemUrl: workItem.url,
				prNumber: undefined,
				model: 'Gemini 3.5 Flash (High)',
			});
		});

		it('does not store an empty provider URL', async () => {
			const workItem = createMockWorkItem({ statusId: '61e4505c', url: '' });

			await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning({ phase: 'planning', taskId: '10', workItem }),
			);

			expect(createRun).toHaveBeenCalledWith(
				expect.objectContaining({ workItemTitle: workItem.title, workItemUrl: undefined }),
			);
		});

		it('finalizes the run failed and stores its logs for a terminal AgentRunError', async () => {
			phaseImpl = async () => {
				throw new AgentRunError(
					'review agent exited with code 1',
					{ kind: 'error' },
					agentResult({
						cli: 'claude',
						exitCode: 1,
						timedOut: false,
						durationMs: 42,
						stdout: 'so',
						stderr: 'se',
					}),
				);
			};

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-failed');
			expect(completeRun).toHaveBeenCalledExactlyOnceWith('run-1', {
				status: 'failed',
				error: 'review agent exited with code 1',
				engine: 'claude',
				exitCode: 1,
				timedOut: false,
				durationMs: 42,
			});
			expect(storeRunLogs).toHaveBeenCalledExactlyOnceWith('run-1', 'so', 'se');
		});

		it('finalizes the run deferred (not failed) for a rate-limited AgentRunError', async () => {
			vi.useFakeTimers();
			const now = new Date('2026-07-10T10:00:00.000Z');
			vi.setSystemTime(now);
			phaseImpl = async () => {
				throw new AgentRunError(
					'rate limited',
					{ kind: 'rate-limit' },
					agentResult({ exitCode: 1, stdout: 'ro', stderr: 're' }),
				);
			};

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-deferred');
			if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
			expect(completeRun).toHaveBeenCalledTimes(1);
			expect(completeRun.mock.calls[0][1]).toMatchObject({
				status: 'deferred',
				nextRetryAt: new Date(now.getTime() + outcome.retryDelayMs),
			});
			expect(storeRunLogs).toHaveBeenCalledExactlyOnceWith('run-1', 'ro', 're');
			vi.useRealTimers();
		});

		it('still reports phase-succeeded when createRun fails (best-effort, no id to finalize)', async () => {
			createRun.mockRejectedValueOnce(new Error('postgres down'));

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			// Creation failed → no run id → the completion path no-ops.
			expect(completeRun).not.toHaveBeenCalled();
			expect(storeRunLogs).not.toHaveBeenCalled();
		});

		it('still reports phase-succeeded when completeRun rejects (best-effort swallow)', async () => {
			completeRun.mockRejectedValueOnce(new Error('postgres down'));

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
		});

		it('does not create a run row for a no-trigger job', async () => {
			await processJob(createMockGitHubWebhookJob(), createTriggerRegistry());
			expect(createRun).not.toHaveBeenCalled();
		});

		it('does not create a run row for a skipped-in-flight duplicate', async () => {
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			phaseImpl = async () => {
				await gate;
				return { agent: agentResult() };
			};

			const first = processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
			await new Promise((r) => setTimeout(r, 0));

			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			// Only the first (in-flight) run created a row; the skipped duplicate did not.
			expect(createRun).toHaveBeenCalledTimes(1);

			release?.();
			await first;
		});
	});
});

describe('reportInterruptedJobToBoard', () => {
	beforeEach(() => {
		projectLookup = () => PROJECT;
		addComment.mockClear();
		addComment.mockResolvedValue('comment-1');
		commentOnPullRequest.mockClear();
		commentOnPullRequest.mockResolvedValue(99);
	});

	it('comments on the PR for a github (PR/check) job', async () => {
		// createMockGitHubWebhookJob's event carries workItemId '17'.
		await reportInterruptedJobToBoard(
			createMockGitHubWebhookJob(),
			'job stalled more than allowable limit',
		);

		expect(commentOnPullRequest).toHaveBeenCalledTimes(1);
		const [proj, prNumber, body] = commentOnPullRequest.mock.calls[0];
		expect(proj).toBe(PROJECT);
		expect(prNumber).toBe(17);
		expect(body).toContain('SWARM run interrupted');
		expect(body).toContain('job stalled more than allowable limit');
		expect(addComment).not.toHaveBeenCalled();
	});

	it('comments on the work item for a github-projects (board) job', async () => {
		const job = createMockGitHubProjectsWebhookJob();

		await reportInterruptedJobToBoard(job, 'stalled');

		expect(addComment).toHaveBeenCalledTimes(1);
		const [itemId, body] = addComment.mock.calls[0];
		expect(itemId).toBe(job.event.itemNodeId);
		expect(body).toContain('SWARM run interrupted');
		expect(commentOnPullRequest).not.toHaveBeenCalled();
	});

	it('skips silently when the project cannot be resolved', async () => {
		projectLookup = () => undefined;

		await expect(
			reportInterruptedJobToBoard(createMockGitHubWebhookJob(), 'stalled'),
		).resolves.toBeUndefined();
		expect(commentOnPullRequest).not.toHaveBeenCalled();
		expect(addComment).not.toHaveBeenCalled();
	});

	it('skips a github job that carries no PR/issue number', async () => {
		const job = createMockGitHubWebhookJob({
			event: createMockGitHubParsedEvent({ workItemId: undefined }),
		});

		await reportInterruptedJobToBoard(job, 'stalled');

		expect(commentOnPullRequest).not.toHaveBeenCalled();
		expect(addComment).not.toHaveBeenCalled();
	});

	it('swallows malformed job data without throwing', async () => {
		await expect(reportInterruptedJobToBoard({ not: 'a job' }, 'stalled')).resolves.toBeUndefined();
		expect(commentOnPullRequest).not.toHaveBeenCalled();
		expect(addComment).not.toHaveBeenCalled();
	});

	it('swallows a comment failure without throwing', async () => {
		commentOnPullRequest.mockRejectedValue(new Error('github 500'));

		await expect(
			reportInterruptedJobToBoard(createMockGitHubWebhookJob(), 'stalled'),
		).resolves.toBeUndefined();
	});
});
