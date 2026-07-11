/**
 * PM board status-change trigger — SWARM's `pm:status-changed` equivalent
 * (ai/ARCHITECTURE.md "PM: GitHub Projects"), the analogue of Cascade's
 * per-list Trello/Linear status triggers. It's what starts the two PM-driven
 * pipeline phases: a card entering **Planning** starts Planning, a card
 * entering **In progress** starts Implementation (`src/pm/pipeline.ts`).
 *
 * Cascade ships a separate handler per board list because its webhook payload
 * carries the destination list, so each handler matches its own list directly.
 * SWARM can't: `docs/github-projects-v2-api.md` §5 warns the `projects_v2_item`
 * body doesn't carry a reliable new Status value, so the authoritative status
 * comes from a board re-read. Rather than register two handlers that each
 * re-read the same card (two GraphQL round-trips per event, one of them always
 * a wasted "not my phase" miss), this is **one** handler that re-reads once,
 * resolves which phase — if any — the card's Status starts, and dispatches it.
 *
 * Loop prevention (a persona's own board moves must not re-fire the trigger)
 * already happened router-side (`GitHubProjectsRouterAdapter.isSelfAuthored`),
 * so it isn't repeated here.
 */

import type { ProjectConfig } from '../../config/schema.js';
import { createGitHubProjectsProvider } from '../../integrations/pm/github-projects/provider.js';
import { resolvePipelinePhaseForOptionId } from '../../integrations/pm/github-projects/status-mapping.js';
import { logger } from '../../lib/logger.js';
import type { PMProvider } from '../../pm/types.js';
import { recordStatusAndDetectChange } from '../pm-status-dedup.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '../types.js';
import { issueNumberFromUrl } from './shared.js';

/**
 * The `projects_v2_item` actions worth waking the pipeline for (mirrors the
 * router adapter's `TRIGGERING_ACTIONS`, `src/router/adapters/github-projects.ts`
 * — that file's comment explains why `reordered` is included alongside
 * `edited`/`created`). Accepting `reordered` here means this handler can also
 * fire on a pure within-column reorder with no real Status change — `handle`
 * below calls `shouldDispatchForStatus` as the second line of defense against
 * that.
 */
const TRIGGERING_ACTIONS = new Set(['edited', 'created', 'reordered']);

export interface PmStatusTriggerDeps {
	/** Injectable PM-provider factory — defaults to the GitHub Projects provider; overridden in tests. */
	createProvider?: (project: ProjectConfig) => PMProvider;
}

/**
 * Build the PM status-change trigger handler.
 *
 * `matches` is a cheap synchronous shape gate (is this a Status-field edit or a
 * card add on this project's board?); the authoritative "which phase?" decision
 * happens in `handle`, which re-reads the item and returns `null` — the
 * registry's "looked closer, not for me" — when the card's Status doesn't start
 * a PM-driven phase.
 */
export function createPmStatusTrigger(deps: PmStatusTriggerDeps = {}): TriggerHandler {
	const createProvider = deps.createProvider ?? createGitHubProjectsProvider;

	return {
		name: 'pm-status-changed',
		description: 'Starts Planning / Implementation when a board card enters that status',

		matches(ctx: TriggerContext): boolean {
			if (ctx.source !== 'github-projects') return false;
			// Deferred PM phases resume from the original event after the phase's
			// status report moved the card to In progress, so the normal status gate
			// must not discard the retry.
			if (ctx.resumePmPhase) return true;
			const { event, project } = ctx;
			if (!event.action || !TRIGGERING_ACTIONS.has(event.action)) return false;
			// A card added to the board, or dragged to a different Board-view column,
			// is worth a look; a field edit only if it's the Status field (any other
			// field — Priority, Size — is noise here). This mirrors
			// `GitHubProjectsRouterAdapter.isStatusChange`.
			if (event.action === 'created' || event.action === 'reordered') return true;
			return event.changedFieldNodeId === project.githubProjects.statusFieldId;
		},

		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'github-projects') return null;
			const { event, project } = ctx;

			const pm = createProvider(project);
			// Authoritative re-read — never trust a Status lifted from the webhook body
			// (docs/github-projects-v2-api.md §5 step 4).
			const workItem = await pm.getWorkItem(event.itemNodeId);

			if (!workItem.statusId) {
				logger.debug('pm-status: item has no resolvable Status option — skipping', {
					itemNodeId: event.itemNodeId,
				});
				return null;
			}

			// Record the freshly re-read status as this item's latest observed status
			// and learn whether it *changed*. Done for every status — including ones
			// that start no phase (backlog, inProgress, …), before the phase gate below
			// — so that a departure to such a status is remembered: leaving "ToDo" and
			// dragging back later then reads as a genuine change rather than a
			// same-status no-op that gets silently skipped (`pm-status-dedup.ts`).
			const statusChanged = await recordStatusAndDetectChange(event.itemNodeId, workItem.statusId);

			const phase =
				ctx.resumePmPhase ??
				resolvePipelinePhaseForOptionId(project.githubProjects, workItem.statusId);
			if (!phase) {
				// A valid board status that simply doesn't start a phase (backlog, todo,
				// inReview, done) — a "not for me" miss, not an error.
				logger.debug('pm-status: status does not start a PM-driven phase — skipping', {
					itemNodeId: event.itemNodeId,
					statusId: workItem.statusId,
				});
				return null;
			}

			// Second line of defense against the `reordered` action's blind spot (see
			// the `TRIGGERING_ACTIONS` comment above): a pure within-column reorder
			// re-reads the same status every time, so this is the check that actually
			// stops it from re-dispatching the same phase over and over.
			if (!ctx.resumePmPhase && !statusChanged) {
				return null;
			}

			const taskId = issueNumberFromUrl(workItem.url);
			if (!taskId) {
				// No backing Issue number to key the worktree on — a draft item, or a
				// URL shape we don't recognize. Can't run a phase without it; drop
				// rather than throw (a draft card isn't a failed job).
				logger.warn('pm-status: could not resolve issue number from work item URL — skipping', {
					itemNodeId: event.itemNodeId,
					url: workItem.url,
					phase,
				});
				return null;
			}

			logger.debug('pm-status: dispatching pipeline phase', {
				itemNodeId: event.itemNodeId,
				taskId,
				phase,
				resumed: Boolean(ctx.resumePmPhase),
			});
			return { phase, taskId, workItem };
		},
	};
}
