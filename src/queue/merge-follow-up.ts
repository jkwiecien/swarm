/**
 * The durable merge-follow-up queue (issue #278) — a small BullMQ queue
 * dedicated to retrying the Review phase's provider-neutral merge automation
 * (`src/scm/merge.ts`) after a transient `not-ready` outcome.
 *
 * Deliberately separate from `swarm-jobs` (`src/queue/jobs.ts`): a follow-up
 * carries no webhook event and must never re-run the review agent, so it
 * doesn't fit the trigger-driven `SwarmJob` shape `processJob` dispatches —
 * making it a third `SwarmJob` variant would force every trigger-dispatch
 * switch in the codebase to account for a job with no `event`. The processor
 * lives in `src/worker/merge-follow-up.ts`; this module only owns the job
 * shape and its producer, mirroring `src/queue/producer.ts`'s lazy-singleton
 * shape.
 */

import { Queue } from 'bullmq';
import { z } from 'zod';
import { requireEnv } from '../lib/env.js';
import { parseRedisUrl } from '../lib/redis.js';

export const MERGE_FOLLOW_UP_QUEUE_NAME = 'swarm-merge-follow-ups';

export const MergeFollowUpJobSchema = z.object({
	/** The SWARM project (`ProjectConfig.id`) the PR belongs to. */
	projectId: z.string().min(1),
	/** The originating Review run — the row this attempt's outcome is persisted onto. */
	runId: z.string().min(1),
	prNumber: z.string().min(1),
	/** The reviewed head SHA the approval covers; re-checked fresh on every attempt. */
	approvedHeadSha: z.string().min(1),
	/** 1-indexed follow-up attempt number — the Review phase's own immediate try is attempt 0. */
	attempt: z.number().int().positive(),
});

export type MergeFollowUpJob = z.infer<typeof MergeFollowUpJobSchema>;

let queue: Queue<MergeFollowUpJob> | null = null;

/** Lazily construct the shared producer queue, mirroring `src/queue/producer.ts`'s `getQueue`. */
function getMergeFollowUpQueue(): Queue<MergeFollowUpJob> {
	if (!queue) {
		queue = new Queue<MergeFollowUpJob>(MERGE_FOLLOW_UP_QUEUE_NAME, {
			connection: parseRedisUrl(requireEnv('REDIS_URL')),
			defaultJobOptions: {
				// Retry policy for a follow-up is entirely explicit
				// (`scheduleMergeFollowUp`'s own bounded backoff) — BullMQ's own retry
				// would double-schedule on top of it.
				attempts: 1,
				removeOnComplete: { age: 24 * 60 * 60, count: 100 },
				removeOnFail: { age: 7 * 24 * 60 * 60 },
			},
		});
	}
	return queue;
}

/**
 * Schedule one merge-follow-up attempt after `delayMs`. The job id is
 * deterministic — `merge-followup_<runId>_<attempt>` — so a concurrent
 * schedule (a racing worker restart, a redelivered recovery sweep) for the
 * same run and attempt number is dropped by BullMQ rather than stacking a
 * duplicate merge attempt.
 */
export async function enqueueMergeFollowUp(job: MergeFollowUpJob, delayMs: number): Promise<void> {
	const jobId = `merge-followup_${job.runId}_${job.attempt}`;
	await getMergeFollowUpQueue().add('merge-follow-up', job, { jobId, delay: delayMs });
}

/** Close the producer connection — mirrors `src/queue/producer.ts`'s `closeQueue`. */
export async function closeMergeFollowUpQueue(): Promise<void> {
	if (queue) {
		await queue.close();
		queue = null;
	}
}
