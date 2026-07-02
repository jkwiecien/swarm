/**
 * GitHubRouterAdapter — the router-side GitHub logic, ported (and trimmed to
 * SWARM's MVP) from Cascade's `src/router/adapters/github.ts`.
 *
 * Its job for the four inbound event types (`pull_request`,
 * `pull_request_review`, `issue_comment`, `check_suite`) is: parse the raw
 * webhook into a normalized event, resolve which SWARM project owns the repo,
 * decide whether the event was one SWARM produced itself (loop prevention), and
 * run a handler under the right persona's credentials. The actual trigger →
 * agent-type routing that decides *what* to do with an event lands with the
 * trigger registry (a later phase); this adapter owns everything up to and
 * including "which persona acts, and never on our own output".
 */

import { findProjectByRepo } from '../../config/provider.js';
import type { ProjectConfig } from '../../config/schema.js';
import {
	type GitHubPersona,
	getPersonaForLogin,
	isSwarmBot,
	type PersonaIdentities,
	resolvePersonaIdentities,
} from '../../github/personas.js';
import { GitHubSCMIntegration } from '../../github/scm-integration.js';
import { logger } from '../../lib/logger.js';

/** The GitHub webhook event types SWARM acts on. */
export const PROCESSABLE_EVENTS = [
	'pull_request',
	'pull_request_review',
	'issue_comment',
	'check_suite',
] as const;

export type ProcessableEvent = (typeof PROCESSABLE_EVENTS)[number];

/** A raw webhook parsed into the fields the router pipeline needs. */
export interface GitHubParsedEvent {
	eventType: ProcessableEvent;
	/** The webhook `action` (e.g. `opened`, `submitted`, `completed`), if present. */
	action?: string;
	/** Repository as `owner/repo`. */
	repoFullName: string;
	/** PR/issue number as a string, when the event carries one. */
	workItemId?: string;
	/** Login of the account that produced the event (`sender.login`). */
	actorLogin?: string;
	/** Comment-carrying events (`issue_comment`) — the ones a persona can author in reply. */
	isCommentEvent: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function isProcessable(eventType: string): eventType is ProcessableEvent {
	return (PROCESSABLE_EVENTS as readonly string[]).includes(eventType);
}

function extractWorkItemId(
	eventType: ProcessableEvent,
	p: Record<string, unknown>,
): string | undefined {
	const pr = asRecord(p.pull_request);
	if (pr?.number != null) return String(pr.number);

	if (eventType === 'issue_comment') {
		const issue = asRecord(p.issue);
		if (issue?.number != null) return String(issue.number);
	}

	if (eventType === 'check_suite') {
		const suite = asRecord(p.check_suite);
		const prs = suite?.pull_requests as Array<Record<string, unknown>> | undefined;
		if (prs && prs.length > 0 && prs[0].number != null) return String(prs[0].number);
	}

	return undefined;
}

export class GitHubRouterAdapter {
	readonly type = 'github' as const;

	private readonly scm = new GitHubSCMIntegration();

	/**
	 * Normalize a raw webhook body into a `GitHubParsedEvent`. `eventType` comes
	 * from the `X-GitHub-Event` header, not the body. Returns `null` for event
	 * types SWARM doesn't act on, so the caller can drop them without branching.
	 */
	parseWebhook(eventType: string, payload: unknown): GitHubParsedEvent | null {
		if (!isProcessable(eventType)) return null;

		const p = asRecord(payload) ?? {};
		const repo = asRecord(p.repository);
		const repoFullName = (repo?.full_name as string) ?? 'unknown';
		const actorLogin = (asRecord(p.sender)?.login as string) ?? undefined;

		return {
			eventType,
			action: (p.action as string) ?? undefined,
			repoFullName,
			workItemId: extractWorkItemId(eventType, p),
			actorLogin,
			isCommentEvent: eventType === 'issue_comment',
		};
	}

	/** Resolve the SWARM project that owns the event's repo, or `null` if untracked. */
	async resolveProject(event: GitHubParsedEvent): Promise<ProjectConfig | null> {
		return (await findProjectByRepo(event.repoFullName)) ?? null;
	}

	/**
	 * Loop prevention: whether this event was produced by one of SWARM's own
	 * personas. Events with no actor (e.g. a `check_suite` that names no sender)
	 * are treated as not self-authored. On any resolution failure this returns
	 * `false` — but logs it, because a swallowed identity error would silently
	 * disable the guard and let a persona react to its own output.
	 */
	async isSelfAuthored(event: GitHubParsedEvent, project: ProjectConfig): Promise<boolean> {
		if (!event.actorLogin) return false;
		try {
			const identities = await resolvePersonaIdentities(project);
			return isSwarmBot(event.actorLogin, identities);
		} catch (err) {
			logger.error('Failed to resolve persona identities; skipping loop-prevention check', {
				projectId: project.id,
				repoFullName: event.repoFullName,
				error: String(err),
			});
			return false;
		}
	}

	/**
	 * Which SWARM persona, if any, authored the event — the routing primitive
	 * behind "the reviewer's changes_requested goes back to the implementer".
	 * Returns `null` for human-authored events.
	 */
	async personaForEvent(
		event: GitHubParsedEvent,
		identities: PersonaIdentities,
	): Promise<GitHubPersona | null> {
		if (!event.actorLogin) return null;
		return getPersonaForLogin(event.actorLogin, identities);
	}

	/**
	 * Run `fn` under `persona`'s GitHub credentials for the event's project.
	 * This is the dispatch seam: whatever handles the event does its GitHub work
	 * inside here, so every call authenticates as the acting persona.
	 */
	async dispatchWithPersona<T>(
		project: ProjectConfig,
		persona: GitHubPersona,
		fn: () => Promise<T>,
	): Promise<T> {
		return this.scm.withPersonaCredentials(project, persona, fn);
	}
}
