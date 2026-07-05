/**
 * Enqueue seam — the boundary between the webhook receiver and the job queue.
 *
 * The receiver's job (SWARM-9) ends once an event has been authenticated,
 * matched to a project, and cleared by loop prevention; at that point it hands
 * the normalized event here. This module shapes it into the router→worker job
 * contract (`SwarmJobSchema` on `QUEUE_NAME`, `src/queue/jobs.ts`) and enqueues
 * it via the BullMQ producer (`src/queue/producer.ts`, SWARM-35), which the
 * worker consumer (`src/worker/consumer.ts`) then processes. The trigger
 * decision is not embedded here — the worker runs the trigger registry against
 * the parsed event — so the job just carries the event, the project id, and the
 * delivery id.
 */

import type { ProjectConfig } from '../config/schema.js';
import { logger } from '../lib/logger.js';
import { enqueueJob } from '../queue/producer.js';
import type { GitHubParsedEvent } from '../router/adapters/github.js';
import type { GitHubProjectsParsedEvent } from '../router/adapters/github-projects.js';

/**
 * Hand a verified, project-matched, non-self-authored webhook event off to the
 * job queue. `deliveryId` is GitHub's `X-GitHub-Delivery` — carried through for
 * idempotency (the producer uses it as the BullMQ job id) and tracing.
 */
export async function enqueueWebhookEvent(
	event: GitHubParsedEvent,
	project: ProjectConfig,
	deliveryId: string | undefined,
): Promise<void> {
	const jobId = await enqueueJob({
		type: 'github',
		projectId: project.id,
		deliveryId,
		event,
	});
	logger.info('Webhook event enqueued', {
		jobId,
		projectId: project.id,
		repo: event.repoFullName,
		eventType: event.eventType,
		action: event.action,
		workItemId: event.workItemId,
		deliveryId,
	});
}

/**
 * Hand a verified, project-matched, non-self-authored `projects_v2_item` status
 * change off to the job queue — the PM-side counterpart of
 * {@link enqueueWebhookEvent}. The worker re-reads the authoritative item state
 * itself (`src/worker/consumer.ts` re-reads config from Postgres and dispatches
 * against the parsed event), so this stays symmetric with the SCM path: shape
 * the event into a job and enqueue it.
 */
export async function enqueueProjectsEvent(
	event: GitHubProjectsParsedEvent,
	project: ProjectConfig,
	deliveryId: string | undefined,
): Promise<void> {
	const jobId = await enqueueJob({
		type: 'github-projects',
		projectId: project.id,
		deliveryId,
		event,
	});
	logger.info('Projects webhook event enqueued', {
		jobId,
		projectId: project.id,
		projectNodeId: event.projectNodeId,
		eventType: event.eventType,
		action: event.action,
		itemNodeId: event.itemNodeId,
		changedFieldNodeId: event.changedFieldNodeId,
		deliveryId,
	});
}
