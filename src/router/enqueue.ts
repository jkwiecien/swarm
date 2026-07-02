/**
 * Enqueue seam — the boundary between the webhook receiver and the job queue.
 *
 * This is deliberately a stub. The receiver'\''s job (SWARM-9) ends once an event
 * has been authenticated, matched to a project, and cleared by loop prevention;
 * at that point it hands the normalized event here. Turning that event into a
 * `TASK_TYPE_*` job and pushing it onto BullMQ requires the **trigger registry**
 * (which decides *what* to do with an event) and the **worker consumer**
 * (SWARM-17) — neither exists yet, and both own the router→worker job contract
 * (PROJECT.md §5, "Orchestration Input"). Enqueuing a provisional job shape here
 * now would just have to be reworked to match them, so this only logs the
 * hand-off. Replace the body with the real BullMQ producer once the trigger
 * registry lands; the receiver call site does not need to change.
 */

import type { ProjectConfig } from '../config/schema.js';
import { logger } from '../lib/logger.js';
import type { GitHubParsedEvent } from '../router/adapters/github.js';

/**
 * Hand a verified, project-matched, non-self-authored webhook event off toward
 * the job queue. `deliveryId` is GitHub'\''s `X-GitHub-Delivery` — carried through
 * for idempotency/tracing once a real producer consumes it.
 */
export async function enqueueWebhookEvent(
	event: GitHubParsedEvent,
	project: ProjectConfig,
	deliveryId: string | undefined,
): Promise<void> {
	logger.info('Webhook event accepted (enqueue seam — no producer wired yet)', {
		projectId: project.id,
		repo: event.repoFullName,
		eventType: event.eventType,
		action: event.action,
		workItemId: event.workItemId,
		deliveryId,
	});
}
