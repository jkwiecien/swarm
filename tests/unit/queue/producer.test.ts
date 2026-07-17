import type { QueueOptions } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMockGitHubProjectsWebhookJob,
	createMockGitHubWebhookJob,
} from '../../helpers/factories.js';

// Mock BullMQ's Queue so nothing touches Redis — capture constructor args and
// the add()/close() calls the producer makes. Hoisted so the vi.mock factory
// (itself hoisted above imports) can reference them.
const { QueueMock, add, close, getDelayed, getWaiting, getPrioritized, fromId, toKey, zscore } =
	vi.hoisted(() => {
		// Typed with add()'s (name, data, opts) signature so `mock.calls[0]` is a
		// real tuple that destructures/indexes under typecheck (see ai/TESTING.md).
		const add =
			vi.fn<
				(
					name: string,
					data: unknown,
					opts?: { jobId?: string; delay?: number; priority?: number },
				) => Promise<unknown>
			>();
		const close = vi.fn();
		// Job shape covers what `scheduleCoalescedJob` uses (`name`/`remove`),
		// `promoteRetryForRun` uses (`data`/`updateData`/`promote`), and
		// `listPendingJobs` uses (`id`/`data`/`timestamp`/`delay`/`priority`); all
		// optional so a test supplies only the fields its assertion touches.
		type MockJob = {
			id?: string;
			name?: string;
			remove?: () => Promise<void>;
			data?: { runId?: string; rateLimitRetryAttempt?: number; [key: string]: unknown };
			timestamp?: number;
			delay?: number;
			priority?: number;
			updateData?: (data: unknown) => Promise<void>;
			promote?: () => Promise<void>;
		};
		const getDelayed = vi.fn<() => Promise<MockJob[]>>();
		const getWaiting = vi.fn<() => Promise<MockJob[]>>();
		const getPrioritized = vi.fn<() => Promise<MockJob[]>>();
		// `Job.fromId(queue, id)` — the lookup `promoteJobById` uses. Resolves a job
		// exposing `getState`/`promote`, or `undefined` for a reaped/absent id.
		const fromId =
			vi.fn<
				(
					queue: unknown,
					jobId: string,
				) => Promise<{ getState: () => Promise<string>; promote: () => Promise<void> } | undefined>
			>();
		const toKey = vi.fn((type: string) => `bull:swarm-jobs:${type}`);
		const zscore = vi.fn();
		const client = Promise.resolve({ zscore });
		// Typed with the Queue constructor's (name, opts) signature so `mock.calls`
		// is a real tuple — untyped, vi.fn() infers a zero-arg call and indexing
		// `calls[0]` fails to typecheck.
		const QueueMock = vi.fn<
			(
				name: string,
				opts?: QueueOptions,
			) => {
				add: typeof add;
				close: typeof close;
				getDelayed: typeof getDelayed;
				getWaiting: typeof getWaiting;
				getPrioritized: typeof getPrioritized;
				toKey: typeof toKey;
				client: typeof client;
			}
		>(() => ({ add, close, getDelayed, getWaiting, getPrioritized, toKey, client }));
		return { QueueMock, add, close, getDelayed, getWaiting, getPrioritized, fromId, toKey, zscore };
	});

vi.mock('bullmq', () => ({ Queue: QueueMock, Job: { fromId } }));

// The producer holds a lazy Queue singleton at module scope; resetModules gives
// each test a fresh one so "constructed once" assertions aren't cross-polluted.
beforeEach(() => {
	vi.resetModules();
	QueueMock.mockClear();
	add.mockReset();
	add.mockResolvedValue({ id: 'bull-assigned-id' });
	close.mockReset();
	close.mockResolvedValue(undefined);
	getDelayed.mockReset();
	getDelayed.mockResolvedValue([]);
	getWaiting.mockReset();
	getWaiting.mockResolvedValue([]);
	getPrioritized.mockReset();
	getPrioritized.mockResolvedValue([]);
	fromId.mockReset();
	fromId.mockResolvedValue(undefined);
	toKey.mockClear();
	zscore.mockReset();
	zscore.mockResolvedValue(null);
	process.env.REDIS_URL = 'redis://localhost:6379';
});

describe('enqueueJob', () => {
	it('creates the queue on QUEUE_NAME with the parsed Redis connection', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		await enqueueJob(createMockGitHubWebhookJob());

		expect(QueueMock).toHaveBeenCalledOnce();
		const [name, opts] = QueueMock.mock.calls[0];
		expect(name).toBe('swarm-jobs');
		expect(opts).toMatchObject({ connection: { host: 'localhost', port: 6379 } });
	});

	it('configures the load-bearing default job options', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		await enqueueJob(createMockGitHubWebhookJob());

		const [, opts] = QueueMock.mock.calls[0];
		// The retry-safety + Redis-hygiene story hinges on these exact values —
		// lock them against accidental regression (see producer.ts rationale).
		expect(opts).toMatchObject({
			defaultJobOptions: {
				attempts: 3,
				backoff: { type: 'exponential', delay: 5_000 },
				removeOnComplete: { age: 24 * 60 * 60, count: 100 },
				removeOnFail: { age: 7 * 24 * 60 * 60 },
			},
		});
	});

	it('adds a github job named by its type, using deliveryId as the job id', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const job = createMockGitHubWebhookJob();

		const id = await enqueueJob(job);

		expect(add).toHaveBeenCalledWith('github', job, { jobId: job.deliveryId });
		expect(id).toBe('bull-assigned-id');
	});

	it('adds a github-projects job named by its type, demoted below the default priority', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const job = createMockGitHubProjectsWebhookJob();

		await enqueueJob(job);

		// PM-board jobs (planning/implementation) must not queue ahead of a
		// review-lifecycle (`github`) job — see priorityFor's rationale.
		expect(add).toHaveBeenCalledWith('github-projects', job, {
			jobId: job.deliveryId,
			priority: 10,
		});
	});

	it('leaves a github job at the default (unset) priority', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const job = createMockGitHubWebhookJob();

		await enqueueJob(job);

		const [, , opts] = add.mock.calls[0];
		expect(opts).not.toHaveProperty('priority');
	});

	it('omits the job id when the event carries no deliveryId', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const { deliveryId: _dropped, ...job } = createMockGitHubWebhookJob();

		await enqueueJob(job);

		expect(add).toHaveBeenCalledWith('github', job, undefined);
	});

	it('reuses the one queue singleton across enqueues', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		await enqueueJob(createMockGitHubWebhookJob());
		await enqueueJob(createMockGitHubProjectsWebhookJob());

		expect(QueueMock).toHaveBeenCalledOnce();
		expect(add).toHaveBeenCalledTimes(2);
	});

	it('throws if REDIS_URL is unset (config error surfaces at first enqueue)', async () => {
		process.env.REDIS_URL = '';
		const { enqueueJob } = await import('@/queue/producer.js');

		await expect(enqueueJob(createMockGitHubWebhookJob())).rejects.toThrow(/REDIS_URL/);
		expect(QueueMock).not.toHaveBeenCalled();
	});
});

describe('scheduleCoalescedJob', () => {
	it('adds a delayed job named by the coalesce key, with a unique colon-free id', async () => {
		const { scheduleCoalescedJob } = await import('@/queue/producer.js');
		const job = createMockGitHubWebhookJob();

		await scheduleCoalescedJob(job, 'check-suite:jkwiecien/swarm:9:cafe', 30_000);

		expect(add).toHaveBeenCalledOnce();
		const [name, addedJob, opts] = add.mock.calls[0];
		expect(name).toBe('check-suite:jkwiecien/swarm:9:cafe');
		expect(addedJob).toBe(job);
		expect(opts).toMatchObject({ delay: 30_000 });
		expect(opts?.jobId).toMatch(/^coalesce_/);
		expect(opts?.jobId).not.toContain(':');
	});

	it('supersedes pending jobs sharing the coalesce key before scheduling', async () => {
		const remove = vi.fn().mockResolvedValue(undefined);
		const staleRemove = vi.fn().mockResolvedValue(undefined);
		getDelayed.mockResolvedValue([
			{ name: 'check-suite:jkwiecien/swarm:9:cafe', remove },
			{ name: 'some-other-key', remove: staleRemove },
		]);
		getWaiting.mockResolvedValue([]);
		const { scheduleCoalescedJob } = await import('@/queue/producer.js');

		await scheduleCoalescedJob(
			createMockGitHubWebhookJob(),
			'check-suite:jkwiecien/swarm:9:cafe',
			30_000,
		);

		expect(remove).toHaveBeenCalledOnce();
		expect(staleRemove).not.toHaveBeenCalled();
		expect(add).toHaveBeenCalledOnce();
	});

	it('supersedes a matching job found in the waiting set (delay elapsed, not yet picked up)', async () => {
		// A prior recheck whose delay already elapsed sits in `waiting`, not
		// `delayed` — the supersede must match it there too, else two rechecks
		// for one key survive.
		const remove = vi.fn().mockResolvedValue(undefined);
		const staleRemove = vi.fn().mockResolvedValue(undefined);
		getDelayed.mockResolvedValue([]);
		getWaiting.mockResolvedValue([
			{ name: 'check-suite:jkwiecien/swarm:9:cafe', remove },
			{ name: 'some-other-key', remove: staleRemove },
		]);
		const { scheduleCoalescedJob } = await import('@/queue/producer.js');

		await scheduleCoalescedJob(
			createMockGitHubWebhookJob(),
			'check-suite:jkwiecien/swarm:9:cafe',
			30_000,
		);

		expect(remove).toHaveBeenCalledOnce();
		expect(staleRemove).not.toHaveBeenCalled();
		expect(add).toHaveBeenCalledOnce();
	});

	it('schedules without removing anything when no pending job matches', async () => {
		const { scheduleCoalescedJob } = await import('@/queue/producer.js');

		await scheduleCoalescedJob(
			createMockGitHubWebhookJob(),
			'check-suite:jkwiecien/swarm:9:cafe',
			30_000,
		);

		expect(add).toHaveBeenCalledOnce();
	});

	it('demotes a coalesced github-projects job below the default priority', async () => {
		const { scheduleCoalescedJob } = await import('@/queue/producer.js');

		await scheduleCoalescedJob(createMockGitHubProjectsWebhookJob(), 'pm-status:some-item', 30_000);

		const [, , opts] = add.mock.calls[0];
		expect(opts).toMatchObject({ priority: 10 });
	});
});

describe('enqueueDelayedRetry', () => {
	it('keeps a deferred review-lifecycle job at BullMQ top priority', async () => {
		const { enqueueDelayedRetry } = await import('@/queue/producer.js');

		await enqueueDelayedRetry(createMockGitHubWebhookJob(), 6 * 60 * 1000);

		const [, , opts] = add.mock.calls[0];
		expect(opts).not.toHaveProperty('priority');
	});

	it('adds a delayed job with a colon-free id keyed on (deliveryId, attempt), not the bare deliveryId', async () => {
		const { enqueueDelayedRetry } = await import('@/queue/producer.js');
		const job = createMockGitHubWebhookJob({ rateLimitRetryAttempt: 1 });

		const id = await enqueueDelayedRetry(job, 6 * 60 * 1000);

		expect(add).toHaveBeenCalledOnce();
		const [name, addedJob, opts] = add.mock.calls[0];
		expect(name).toBe('github');
		expect(addedJob).toBe(job);
		expect(opts).toMatchObject({ delay: 6 * 60 * 1000 });
		// Keyed on delivery id + attempt (not the bare delivery id, whose completed
		// job is still in Redis) so a double-fired completed event dedups instead of
		// stacking a duplicate retry.
		expect(opts?.jobId).toBe(`retry_github_${job.deliveryId}_attempt1`);
		expect(opts?.jobId).not.toBe(job.deliveryId);
		expect(opts?.jobId).not.toContain(':');
		expect(id).toBe('bull-assigned-id');
	});

	it('is deterministic per attempt — the same (deliveryId, attempt) yields the same id', async () => {
		const { enqueueDelayedRetry } = await import('@/queue/producer.js');
		const job = createMockGitHubWebhookJob({ rateLimitRetryAttempt: 2 });

		await enqueueDelayedRetry(job, 6 * 60 * 1000);
		await enqueueDelayedRetry(job, 6 * 60 * 1000);

		const [, , first] = add.mock.calls[0];
		const [, , second] = add.mock.calls[1];
		expect(first?.jobId).toBe(second?.jobId);
	});

	it('falls back to a fresh unique id when the job carries no deliveryId', async () => {
		const { enqueueDelayedRetry } = await import('@/queue/producer.js');
		const { deliveryId: _dropped, ...job } = createMockGitHubWebhookJob({
			rateLimitRetryAttempt: 1,
		});

		await enqueueDelayedRetry(job, 6 * 60 * 1000);

		const [, , opts] = add.mock.calls[0];
		expect(opts?.jobId).toMatch(/^retry_github_\d+_/);
		expect(opts?.jobId).not.toContain(':');
	});

	it('uses a fresh id for a manually reconstructed retry', async () => {
		const { enqueueDelayedRetry } = await import('@/queue/producer.js');
		const job = createMockGitHubWebhookJob({ deliveryId: 'delivery-1' });

		await enqueueDelayedRetry(job, 0, { unique: true });

		const [, , opts] = add.mock.calls[0];
		expect(opts?.jobId).toMatch(/^retry_github_delivery-1_attempt0_\d+_/);
	});

	it('demotes a retried github-projects job below the default priority', async () => {
		const { enqueueDelayedRetry } = await import('@/queue/producer.js');
		const job = createMockGitHubProjectsWebhookJob({ rateLimitRetryAttempt: 1 });

		await enqueueDelayedRetry(job, 6 * 60 * 1000);

		const [, , opts] = add.mock.calls[0];
		expect(opts).toMatchObject({ priority: 10 });
	});
});

describe('promoteRetryForRun', () => {
	it('promotes the delayed retry whose data carries the runId, resetting its attempt counter', async () => {
		const updateData = vi.fn().mockResolvedValue(undefined);
		const promote = vi.fn().mockResolvedValue(undefined);
		const match = { data: { runId: 'run-42', rateLimitRetryAttempt: 4 }, updateData, promote };
		getDelayed.mockResolvedValue([
			{ data: { runId: 'other' }, updateData: vi.fn(), promote: vi.fn() },
			match,
		]);
		const { promoteRetryForRun } = await import('@/queue/producer.js');

		const result = await promoteRetryForRun('run-42');

		expect(result).toBe(true);
		// Attempt counter reset to 0 so the manual retry bypasses MAX_RATE_LIMIT_RETRIES.
		expect(match.data.rateLimitRetryAttempt).toBe(0);
		expect(updateData).toHaveBeenCalledOnce();
		expect(updateData).toHaveBeenCalledWith(match.data);
		expect(promote).toHaveBeenCalledOnce();
	});

	it('returns true without promoting when the retry is already waiting (delay elapsed)', async () => {
		// A retry whose delay already elapsed sits in `waiting`, about to run on its
		// own — treated as already-retrying, not absent, so no double-fire (no
		// `promote()`), but its attempt counter is still reset in place.
		const updateData = vi.fn().mockResolvedValue(undefined);
		getDelayed.mockResolvedValue([]);
		getWaiting.mockResolvedValue([
			{ data: { runId: 'run-7', rateLimitRetryAttempt: 3 }, updateData },
		]);
		const { promoteRetryForRun } = await import('@/queue/producer.js');

		expect(await promoteRetryForRun('run-7')).toBe(true);
		expect(updateData).toHaveBeenCalledOnce();
	});

	it('applies cli/model overrides onto an already-waiting retry (issue #165 regression)', async () => {
		// The confirmed bug: a manual retry with overrides hit a retry already in
		// `waiting`, which previously ran on the *original* engine because the
		// overrides were dropped. They must be written onto its data instead.
		const updateData = vi.fn().mockResolvedValue(undefined);
		const data = { runId: 'run-9', rateLimitRetryAttempt: 2 } as Record<string, unknown>;
		getDelayed.mockResolvedValue([]);
		getWaiting.mockResolvedValue([{ data, updateData }]);
		const { promoteRetryForRun } = await import('@/queue/producer.js');

		expect(await promoteRetryForRun('run-9', 'codex', 'gpt-5.6-terra')).toBe(true);
		expect(data.cliOverride).toBe('codex');
		expect(data.modelOverride).toBe('gpt-5.6-terra');
		expect(data.rateLimitRetryAttempt).toBe(0);
		expect(updateData).toHaveBeenCalledWith(data);
	});

	it('clears resumeSession and assigns a fresh agentSessionId when freshSession is true', async () => {
		const updateData = vi.fn().mockResolvedValue(undefined);
		const promote = vi.fn().mockResolvedValue(undefined);
		const data = {
			runId: 'run-42',
			rateLimitRetryAttempt: 4,
			resumeSession: true,
			agentSessionId: 'old-session-uuid',
		} as Record<string, unknown>;
		const match = { data, updateData, promote };
		getDelayed.mockResolvedValue([match]);
		const { promoteRetryForRun } = await import('@/queue/producer.js');

		const result = await promoteRetryForRun('run-42', undefined, undefined, undefined, true);

		expect(result).toBe(true);
		expect(data.rateLimitRetryAttempt).toBe(0);
		expect(data.resumeSession).toBeUndefined();
		expect(data.agentSessionId).not.toBe('old-session-uuid');
		expect(data.agentSessionId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
		expect(updateData).toHaveBeenCalledWith(data);
	});

	it('returns false when no pending job carries the runId', async () => {
		getDelayed.mockResolvedValue([{ data: { runId: 'someone-else' }, promote: vi.fn() }]);
		getWaiting.mockResolvedValue([]);
		const { promoteRetryForRun } = await import('@/queue/producer.js');

		expect(await promoteRetryForRun('run-42')).toBe(false);
	});
});

describe('promoteJobById', () => {
	it('promotes a delayed job by id and returns true', async () => {
		const promote = vi.fn().mockResolvedValue(undefined);
		fromId.mockResolvedValue({ getState: async () => 'delayed', promote });
		const { promoteJobById } = await import('@/queue/producer.js');

		expect(await promoteJobById('retry-1')).toBe(true);
		expect(fromId).toHaveBeenCalledWith(expect.anything(), 'retry-1');
		expect(promote).toHaveBeenCalledOnce();
	});

	it('returns false when no job matches the id (reaped or never existed)', async () => {
		fromId.mockResolvedValue(undefined);
		const { promoteJobById } = await import('@/queue/producer.js');

		expect(await promoteJobById('gone')).toBe(false);
	});

	it('returns true without promoting a job already waiting (its delay elapsed)', async () => {
		const promote = vi.fn().mockResolvedValue(undefined);
		fromId.mockResolvedValue({ getState: async () => 'waiting', promote });
		const { promoteJobById } = await import('@/queue/producer.js');

		expect(await promoteJobById('retry-2')).toBe(true);
		expect(promote).not.toHaveBeenCalled();
	});

	it('returns false for a job no longer runnable (already active/completed)', async () => {
		const promote = vi.fn().mockResolvedValue(undefined);
		fromId.mockResolvedValue({ getState: async () => 'active', promote });
		const { promoteJobById } = await import('@/queue/producer.js');

		expect(await promoteJobById('retry-3')).toBe(false);
		expect(promote).not.toHaveBeenCalled();
	});
});

describe('removePendingRetryForRun', () => {
	it('removes every pending delayed/waiting job carrying the runId and returns the count', async () => {
		const removeMatch = vi.fn().mockResolvedValue(undefined);
		const removeWaiting = vi.fn().mockResolvedValue(undefined);
		const removeOther = vi.fn().mockResolvedValue(undefined);
		getDelayed.mockResolvedValue([
			{ data: { runId: 'run-9' }, remove: removeMatch },
			{ data: { runId: 'someone-else' }, remove: removeOther },
		]);
		getWaiting.mockResolvedValue([{ data: { runId: 'run-9' }, remove: removeWaiting }]);
		const { removePendingRetryForRun } = await import('@/queue/producer.js');

		const removed = await removePendingRetryForRun('run-9');

		expect(removed).toBe(2);
		expect(removeMatch).toHaveBeenCalledOnce();
		expect(removeWaiting).toHaveBeenCalledOnce();
		expect(removeOther).not.toHaveBeenCalled();
	});

	it('returns 0 and removes nothing when no pending job carries the runId', async () => {
		getDelayed.mockResolvedValue([{ data: { runId: 'other' }, remove: vi.fn() }]);
		getWaiting.mockResolvedValue([]);
		const { removePendingRetryForRun } = await import('@/queue/producer.js');

		expect(await removePendingRetryForRun('run-9')).toBe(0);
	});
});

describe('listPendingJobs', () => {
	it('queries all three pending sets and tags each snapshot with its source state', async () => {
		const githubJob = createMockGitHubWebhookJob();
		const boardJob = createMockGitHubProjectsWebhookJob();
		getWaiting.mockResolvedValue([
			{ id: 'w-1', data: githubJob, timestamp: 1000, delay: 0, priority: 0 },
		]);
		// The critical case this test guards: board (`github-projects`) jobs carry
		// `priority: 10` and BullMQ v5 stores them in `prioritized`, not `waiting` —
		// a `listPendingJobs` that only queried `getWaiting` would miss them.
		getPrioritized.mockResolvedValue([
			{ id: 'p-1', data: boardJob, timestamp: 2000, delay: 0, priority: 10 },
		]);
		getDelayed.mockResolvedValue([
			{ id: 'd-1', data: githubJob, timestamp: 3000, delay: 30_000, priority: 0 },
		]);
		const { listPendingJobs } = await import('@/queue/producer.js');

		const snapshots = await listPendingJobs();

		expect(getWaiting).toHaveBeenCalledOnce();
		expect(getPrioritized).toHaveBeenCalledOnce();
		expect(getDelayed).toHaveBeenCalledOnce();
		expect(snapshots).toEqual([
			{
				jobId: 'w-1',
				type: 'github',
				state: 'waiting',
				data: githubJob,
				enqueuedAt: 1000,
				delayMs: 0,
				priority: 0,
			},
			{
				jobId: 'p-1',
				type: 'github-projects',
				state: 'prioritized',
				data: boardJob,
				enqueuedAt: 2000,
				delayMs: 0,
				priority: 10,
			},
			{
				jobId: 'd-1',
				type: 'github',
				state: 'delayed',
				data: githubJob,
				enqueuedAt: 3000,
				delayMs: 30_000,
				priority: 0,
			},
		]);
	});

	it('copies timestamp/delay/priority through, defaulting delay/priority when absent', async () => {
		getWaiting.mockResolvedValue([
			{ id: 'w-1', data: createMockGitHubWebhookJob(), timestamp: 1000 },
		]);
		const { listPendingJobs } = await import('@/queue/producer.js');

		const [snapshot] = await listPendingJobs();

		expect(snapshot.enqueuedAt).toBe(1000);
		expect(snapshot.delayMs).toBe(0);
		expect(snapshot.priority).toBe(0);
	});

	it('falls back to an empty jobId when the job carries none', async () => {
		getWaiting.mockResolvedValue([{ data: createMockGitHubWebhookJob(), timestamp: 1000 }]);
		const { listPendingJobs } = await import('@/queue/producer.js');

		expect((await listPendingJobs())[0].jobId).toBe('');
	});

	it('returns an empty array when nothing is pending', async () => {
		const { listPendingJobs } = await import('@/queue/producer.js');

		expect(await listPendingJobs()).toEqual([]);
	});

	it('fetches actual runsAt score from the delayed zset when client is available', async () => {
		const githubJob = createMockGitHubWebhookJob();
		getDelayed.mockResolvedValue([
			{ id: 'd-1', data: githubJob, timestamp: 3000, delay: 30_000, priority: 0 },
		]);
		const { listPendingJobs } = await import('@/queue/producer.js');

		zscore.mockResolvedValueOnce(String(1700000030000 * 0x1000));

		const snapshots = await listPendingJobs();

		expect(snapshots).toEqual([
			{
				jobId: 'd-1',
				type: 'github',
				state: 'delayed',
				data: githubJob,
				enqueuedAt: 3000,
				delayMs: 30_000,
				priority: 0,
				runsAt: 1700000030000,
			},
		]);
		expect(toKey).toHaveBeenCalledWith('delayed');
		expect(zscore).toHaveBeenCalledWith('bull:swarm-jobs:delayed', 'd-1');
	});
});

describe('closeQueue', () => {
	it('closes the queue once it has been created', async () => {
		const { enqueueJob, closeQueue } = await import('@/queue/producer.js');
		await enqueueJob(createMockGitHubWebhookJob());

		await closeQueue();

		expect(close).toHaveBeenCalledOnce();
	});

	it('is a no-op when nothing was ever enqueued', async () => {
		const { closeQueue } = await import('@/queue/producer.js');

		await expect(closeQueue()).resolves.toBeUndefined();
		expect(close).not.toHaveBeenCalled();
	});

	it('recreates the queue on the next enqueue after a close', async () => {
		const { enqueueJob, closeQueue } = await import('@/queue/producer.js');
		await enqueueJob(createMockGitHubWebhookJob());
		await closeQueue();
		await enqueueJob(createMockGitHubWebhookJob());

		expect(QueueMock).toHaveBeenCalledTimes(2);
	});
});
