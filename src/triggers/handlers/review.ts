/**
 * Review trigger — starts the Review phase (`src/pipeline/review.ts`) when a PR
 * is opened or its checks finish, mirroring Cascade's review-agent trigger on
 * `check_suite` completion (ai/ARCHITECTURE.md "Pipeline phases" #3).
 *
 * Two entry events, one handler:
 *  - `pull_request` `opened` (non-draft) — review the freshly opened PR.
 *  - `check_suite` `completed` — review the commit CI just validated, which is
 *    why the phase pins its checkout to the head SHA.
 *
 * **Aggregate check state, not this suite's conclusion.** GitHub fires one
 * `check_suite.completed` per workflow, so any single event's own `conclusion`
 * describes only its suite while siblings may still be running. On a
 * `check_suite` event the handler re-queries *every* check on the head SHA
 * (`getCheckSuiteStatus`) and decides via `decideCheckSuiteOutcome`
 * (`check-suite-decision.ts`): review if all complete and none failed, skip if
 * a check failed (respond-to-ci is deferred to #64), or **defer** if some check
 * is still incomplete. Ported from Cascade's `check-suite-success` trigger.
 *
 * **Deferred recheck.** A defer schedules a coalesced re-enqueue of this same
 * event ~30s out (`scheduleCoalescedJob`). This guards the case where the
 * Actions API lags webhook delivery — the suite reports complete over the
 * webhook, but a query moments later still shows it `in_progress`, and no
 * further webhook will arrive to wake us. The recheck re-queries fresh API
 * state; `recheckAttempt` caps the loop so a permanently-stale API can't
 * reschedule forever (a genuinely slow CI run is re-triggered by its own later
 * `check_suite` webhook, so the cap can't drop a legitimate review). A *failed*
 * aggregate query (transient Actions-API error, or an unresolvable reviewer
 * token) degrades to the same bounded recheck rather than throwing out of the
 * handler and burning the job's retries — see `resolveCheckSuiteReview`.
 *
 * **Same-repo gate.** Fork PRs are dropped (`pull_request` events, via
 * `isCrossRepo`): the Review phase's `provision` fetches only the base repo's
 * refs, so a fork's head SHA is unreachable and the detached checkout would
 * fail the job (see `src/pipeline/review.ts`'s header). A `check_suite` payload
 * doesn't reliably tell us fork-ness, so that path can't pre-filter forks — an
 * unreachable SHA there surfaces as a failed job rather than a silent drop.
 *
 * **Cross-process dedup.** A PR that opens *and* then passes checks (or a PR
 * with several check suites) would otherwise dispatch Review more than once for
 * the same head SHA, each burning agent tokens. `handle` claims a Redis-backed
 * slot keyed on the PR+SHA (`review-dispatch-dedup.ts`) before returning a
 * dispatch; a duplicate claim short-circuits to a skip. The claim happens here,
 * at the single dispatch-decision point, so the duplicate is dropped before any
 * worktree is provisioned.
 */

import type { ProjectConfig } from '../../config/schema.js';
import {
	type CheckSuiteStatus,
	getCheckSuiteStatus,
} from '../../integrations/scm/github/client.js';
import { GitHubSCMIntegration } from '../../integrations/scm/github/scm-integration.js';
import { logger } from '../../lib/logger.js';
import { scheduleCoalescedJob } from '../../queue/producer.js';
import type { GitHubParsedEvent } from '../../router/adapters/github.js';
import { buildReviewDispatchKey, claimReviewDispatch } from '../review-dispatch-dedup.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '../types.js';
import { decideCheckSuiteOutcome } from './check-suite-decision.js';

/** How long to wait before re-querying check state when the Actions API looks stale. */
const RECHECK_DELAY_MS = 30_000;

/**
 * Cap on deferred rechecks per job. ~10 min of Actions-API lag at
 * {@link RECHECK_DELAY_MS} — well beyond any real lag, and past it a fresh
 * `check_suite` webhook (which every completing suite emits) re-triggers anyway,
 * so the cap can only stop a pathological self-reschedule loop, never drop a
 * legitimate review.
 */
const MAX_CHECK_SUITE_RECHECKS = 20;

/**
 * True when the event is a review entry point by *shape* — an opened PR or a
 * completed check suite. The draft/fork/aggregate-CI specifics are decided in
 * `handle` so a near-miss can fall through to the registry's next handler.
 */
function matchesReviewShape(ctx: TriggerContext): boolean {
	if (ctx.source !== 'github') return false;
	const { event } = ctx;
	if (event.eventType === 'pull_request' && event.action === 'opened') return true;
	if (event.eventType === 'check_suite' && event.action === 'completed') return true;
	return false;
}

/**
 * The `pull_request`-only gate: a PR must be a non-draft, same-repo PR to be
 * reviewable. Logs and returns false on a near-miss so `handle` can fall through
 * to the registry's next handler.
 */
function isReviewablePullRequest(event: GitHubParsedEvent, prNumber: string): boolean {
	if (event.isDraft) {
		logger.debug('review: PR is a draft — skipping', { prNumber });
		return false;
	}
	if (event.isCrossRepo) {
		logger.info('review: fork PR — skipping (head SHA unreachable for review)', { prNumber });
		return false;
	}
	return true;
}

/**
 * Schedule a bounded, coalesced recheck of this `check_suite` event, or give up
 * once {@link MAX_CHECK_SUITE_RECHECKS} is reached. Always returns `false` — the
 * event is fully handled here whether a recheck was queued or the cap stopped
 * the loop. Shared by the two defer paths in {@link resolveCheckSuiteReview}:
 * some check still incomplete, and a failed aggregate query. `details` is merged
 * into the log line so each caller records why it deferred.
 */
async function scheduleCheckSuiteRecheck(
	project: ProjectConfig,
	event: GitHubParsedEvent,
	deliveryId: string | undefined,
	recheckAttempt: number,
	prNumber: string,
	headSha: string,
	details: Record<string, unknown>,
): Promise<false> {
	if (recheckAttempt >= MAX_CHECK_SUITE_RECHECKS) {
		logger.warn('review: giving up on check-suite recheck (cap reached)', {
			prNumber,
			headSha,
			recheckAttempt,
			...details,
		});
		return false;
	}

	const coalesceKey = `check-suite:${project.repo}:${prNumber}:${headSha}`;
	await scheduleCoalescedJob(
		{
			type: 'github',
			projectId: project.id,
			...(deliveryId ? { deliveryId } : {}),
			recheckAttempt: recheckAttempt + 1,
			event,
		},
		coalesceKey,
		RECHECK_DELAY_MS,
	);
	logger.info('review: scheduled deferred check-suite recheck', {
		prNumber,
		headSha,
		recheckAttempt: recheckAttempt + 1,
		delayMs: RECHECK_DELAY_MS,
		coalesceKey,
		...details,
	});
	return false;
}

/**
 * Decide a `check_suite` event's fate from the head SHA's *aggregate* check
 * state. Returns `true` to proceed to review; `false` when the event was
 * handled here (a failed suite skipped, or an incomplete suite's recheck
 * scheduled). The aggregate query runs as the reviewer persona — read-only, and
 * the persona whose review follows.
 *
 * The query resolves the reviewer token and hits the Actions API, so it can
 * throw — a transient 5xx/rate-limit/network blip, or a project with no
 * resolvable reviewer token. That throw must not escape `handle`: it would land
 * outside `processJob`'s `runPhase`-only try/catch, failing the job and burning
 * its BullMQ retries re-running this same query (an implementer-token-only
 * project would fail+retry on *every* `check_suite` event). We degrade to a
 * bounded recheck instead — Cascade skips on error; we defer so a transient blip
 * can't silently drop a legitimate review, and the cap winds a persistent
 * failure down to one warn+drop rather than a retry storm.
 */
async function resolveCheckSuiteReview(
	project: ProjectConfig,
	event: GitHubParsedEvent,
	deliveryId: string | undefined,
	recheckAttempt: number,
	prNumber: string,
	headSha: string,
): Promise<boolean> {
	const [owner, repo] = project.repo.split('/');
	const scm = new GitHubSCMIntegration();

	let checkStatus: CheckSuiteStatus;
	try {
		checkStatus = await scm.withPersonaCredentials(project, 'reviewer', () =>
			getCheckSuiteStatus(owner, repo, headSha),
		);
	} catch (err) {
		return scheduleCheckSuiteRecheck(
			project,
			event,
			deliveryId,
			recheckAttempt,
			prNumber,
			headSha,
			{ reason: 'aggregate query failed', error: err instanceof Error ? err.message : String(err) },
		);
	}

	const decision = decideCheckSuiteOutcome(checkStatus, prNumber);
	if (decision.action === 'review') return true;

	if (decision.action === 'skip') {
		logger.info('review: check suite not reviewable — skipping', {
			prNumber,
			message: decision.message,
		});
		return false;
	}

	// defer — some check is still incomplete; re-query fresh API state shortly.
	return scheduleCheckSuiteRecheck(project, event, deliveryId, recheckAttempt, prNumber, headSha, {
		incompleteChecks: decision.incompleteChecks,
	});
}

/**
 * Whether a shape-matched event should proceed to a Review dispatch, routing to
 * the per-event-type gate: a `pull_request`'s draft/fork check, or a
 * `check_suite`'s aggregate-CI decision (which may defer/skip in place).
 */
function isReviewable(
	project: ProjectConfig,
	event: GitHubParsedEvent,
	deliveryId: string | undefined,
	recheckAttempt: number,
	prNumber: string,
	headSha: string,
): Promise<boolean> {
	if (event.eventType === 'pull_request') {
		return Promise.resolve(isReviewablePullRequest(event, prNumber));
	}
	return resolveCheckSuiteReview(project, event, deliveryId, recheckAttempt, prNumber, headSha);
}

export function createReviewTrigger(): TriggerHandler {
	return {
		name: 'pr-review',
		description: 'Starts the Review phase on a PR opened / check suite completing',

		matches: matchesReviewShape,

		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'github') return null;
			const { event } = ctx;

			const prNumber = event.workItemId;
			if (!prNumber) {
				// A check suite with no associated PR, or a PR event missing its number —
				// nothing to review.
				logger.debug('review: event carries no PR number — skipping', {
					eventType: event.eventType,
				});
				return null;
			}

			if (!event.headSha) {
				// The Review phase pins its checkout to the head SHA; without it there's
				// nothing to review against.
				logger.warn('review: event carries no head SHA — skipping', {
					prNumber,
					eventType: event.eventType,
				});
				return null;
			}

			const proceed = await isReviewable(
				ctx.project,
				event,
				ctx.deliveryId,
				ctx.recheckAttempt ?? 0,
				prNumber,
				event.headSha,
			);
			if (!proceed) return null;

			// Cross-process dedup: claim this PR+SHA before dispatching so a sibling
			// event for the same commit (PR opened → check suite passed, or one
			// success per CI suite) doesn't launch a second review. Fails closed, so
			// a claim we can't obtain (duplicate, or Redis down) drops to a skip.
			const dispatchKey = buildReviewDispatchKey(ctx.project.repo, prNumber, event.headSha);
			const claimed = await claimReviewDispatch(dispatchKey, 'pr-review', {
				prNumber,
				headSha: event.headSha,
			});
			if (!claimed) return null;

			logger.info('review: dispatching Review phase', { prNumber, headSha: event.headSha });
			return { phase: 'review', taskId: prNumber, prNumber, headSha: event.headSha };
		},
	};
}
