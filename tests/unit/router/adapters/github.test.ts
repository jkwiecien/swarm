import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../helpers/factories.js';

vi.mock('@/config/provider.js', () => ({
	findProjectByRepo: vi.fn(),
}));
vi.mock('@/integrations/scm/github/personas.js', () => ({
	resolvePersonaIdentities: vi.fn(),
	isSwarmBot: vi.fn(),
	getPersonaForLogin: vi.fn(),
}));
const withPersonaCredentials = vi.fn(
	(_project: unknown, _persona: unknown, fn: () => Promise<unknown>) => fn(),
);
vi.mock('@/integrations/scm/github/scm-integration.js', () => ({
	GitHubSCMIntegration: class {
		withPersonaCredentials = withPersonaCredentials;
	},
}));

import { findProjectByRepo } from '@/config/provider.js';
import {
	getPersonaForLogin,
	isSwarmBot,
	type PersonaIdentities,
	resolvePersonaIdentities,
} from '@/integrations/scm/github/personas.js';
import { GitHubRouterAdapter } from '@/router/adapters/github.js';

const IDENTITIES: PersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };
const project = createMockProjectConfig({ id: 'proj-1', repo: 'jkwiecien/swarm' });

function repo() {
	return { full_name: 'jkwiecien/swarm' };
}

describe('GitHubRouterAdapter', () => {
	const adapter = new GitHubRouterAdapter();

	// The event types under test are all processable, so parseWebhook never
	// returns null here — narrow it once so the assertions don't repeat `!`.
	function parse(eventType: string, payload: unknown) {
		const event = adapter.parseWebhook(eventType, payload);
		if (!event) throw new Error(`expected ${eventType} to parse`);
		return event;
	}

	beforeEach(() => {
		vi.mocked(findProjectByRepo).mockReset();
		vi.mocked(resolvePersonaIdentities).mockReset();
		vi.mocked(isSwarmBot).mockReset();
		vi.mocked(getPersonaForLogin).mockReset();
		withPersonaCredentials.mockClear();
	});

	describe('parseWebhook', () => {
		it('returns null for an event type SWARM does not act on', () => {
			expect(adapter.parseWebhook('projects_v2_item', { repository: repo() })).toBeNull();
		});

		it('parses a pull_request event', () => {
			const parsed = adapter.parseWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: { number: 42 },
				sender: { login: 'a-human' },
			});
			expect(parsed).toEqual({
				eventType: 'pull_request',
				action: 'opened',
				repoFullName: 'jkwiecien/swarm',
				workItemId: '42',
				actorLogin: 'a-human',
				isCommentEvent: false,
			});
		});

		it('parses an issue_comment event and flags it as a comment event', () => {
			const parsed = adapter.parseWebhook('issue_comment', {
				action: 'created',
				repository: repo(),
				issue: { number: 7 },
				comment: { id: 1 },
				sender: { login: 'swarm-rev' },
			});
			expect(parsed?.workItemId).toBe('7');
			expect(parsed?.isCommentEvent).toBe(true);
			expect(parsed?.actorLogin).toBe('swarm-rev');
		});

		it('extracts the PR number from a check_suite event', () => {
			const parsed = adapter.parseWebhook('check_suite', {
				action: 'completed',
				repository: repo(),
				check_suite: { conclusion: 'success', pull_requests: [{ number: 9 }] },
			});
			expect(parsed?.workItemId).toBe('9');
			expect(parsed?.actorLogin).toBeUndefined();
		});

		it('leaves workItemId undefined for a check_suite with no PRs', () => {
			const parsed = adapter.parseWebhook('check_suite', {
				action: 'completed',
				repository: repo(),
				check_suite: { conclusion: 'success', pull_requests: [] },
			});
			expect(parsed?.workItemId).toBeUndefined();
		});

		it('falls back to "unknown" when the payload has no repository', () => {
			const parsed = adapter.parseWebhook('pull_request', { pull_request: { number: 1 } });
			expect(parsed?.repoFullName).toBe('unknown');
		});

		it('parses a pull_request_review event', () => {
			const parsed = adapter.parseWebhook('pull_request_review', {
				action: 'submitted',
				repository: repo(),
				pull_request: { number: 3 },
				review: { state: 'changes_requested' },
				sender: { login: 'swarm-rev' },
			});
			expect(parsed?.eventType).toBe('pull_request_review');
			expect(parsed?.workItemId).toBe('3');
		});

		it('enriches a pull_request event with head SHA, branch, draft and fork state', () => {
			const parsed = adapter.parseWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: {
					number: 42,
					draft: true,
					head: { sha: 'abc123', ref: 'issue-42', repo: { full_name: 'a-fork/swarm' } },
					base: { ref: 'main', repo: { full_name: 'jkwiecien/swarm' } },
				},
			});
			expect(parsed).toMatchObject({
				headSha: 'abc123',
				prBranch: 'issue-42',
				isDraft: true,
				isCrossRepo: true,
			});
		});

		it('extracts the PR author login from a pull_request event', () => {
			const parsed = adapter.parseWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: {
					number: 42,
					user: { login: 'swarm-impl' },
					head: { sha: 'abc', ref: 'issue-42', repo: { full_name: 'jkwiecien/swarm' } },
					base: { ref: 'main', repo: { full_name: 'jkwiecien/swarm' } },
				},
			});
			expect(parsed?.prAuthorLogin).toBe('swarm-impl');
		});

		it('extracts merged and base branch fields from a closed pull_request event', () => {
			const parsed = adapter.parseWebhook('pull_request', {
				action: 'closed',
				repository: repo(),
				pull_request: { number: 42, merged: true, base: { ref: 'main' } },
			});
			expect(parsed).toMatchObject({ merged: true, baseBranch: 'main' });
		});

		it('leaves prAuthorLogin undefined when the pull_request has no user', () => {
			const parsed = adapter.parseWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: { number: 42 },
			});
			expect(parsed?.prAuthorLogin).toBeUndefined();
		});

		it('marks a same-repo pull_request as not cross-repo', () => {
			const parsed = adapter.parseWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: {
					number: 42,
					head: { sha: 'abc', ref: 'issue-42', repo: { full_name: 'jkwiecien/swarm' } },
					base: { ref: 'main', repo: { full_name: 'jkwiecien/swarm' } },
				},
			});
			expect(parsed?.isCrossRepo).toBe(false);
		});

		it('leaves isCrossRepo undefined when a repo is missing from the payload', () => {
			const parsed = adapter.parseWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: {
					number: 42,
					// base carries no repo — can't tell fork from same-repo, so don't guess.
					head: { sha: 'abc', ref: 'issue-42', repo: { full_name: 'jkwiecien/swarm' } },
					base: { ref: 'main' },
				},
			});
			expect(parsed?.isCrossRepo).toBeUndefined();
		});

		it('enriches a pull_request_review event with state, id, branch and head SHA', () => {
			const parsed = adapter.parseWebhook('pull_request_review', {
				action: 'submitted',
				repository: repo(),
				pull_request: { number: 3, head: { sha: 'deadbeef', ref: 'issue-3' } },
				review: { id: 987654, state: 'changes_requested' },
				sender: { login: 'swarm-rev' },
			});
			expect(parsed).toMatchObject({
				reviewState: 'changes_requested',
				reviewId: '987654',
				prBranch: 'issue-3',
				headSha: 'deadbeef',
			});
		});

		it('enriches a check_suite event with head SHA, conclusion, and the PR branch', () => {
			const parsed = adapter.parseWebhook('check_suite', {
				action: 'completed',
				repository: repo(),
				check_suite: {
					conclusion: 'failure',
					head_sha: 'cafe',
					pull_requests: [{ number: 9, head: { ref: 'issue-9' } }],
				},
			});
			// The PR branch is what the Respond-to-CI phase checks out to push the fix.
			expect(parsed).toMatchObject({
				headSha: 'cafe',
				checkConclusion: 'failure',
				prBranch: 'issue-9',
			});
		});

		it('leaves prBranch undefined for a check_suite with no PRs', () => {
			const parsed = adapter.parseWebhook('check_suite', {
				action: 'completed',
				repository: repo(),
				check_suite: { conclusion: 'failure', head_sha: 'cafe', pull_requests: [] },
			});
			expect(parsed?.prBranch).toBeUndefined();
		});
	});

	describe('resolveProject', () => {
		it('returns the owning project', async () => {
			vi.mocked(findProjectByRepo).mockResolvedValue(project);
			const event = parse('pull_request', {
				repository: repo(),
				pull_request: { number: 1 },
			});
			expect(await adapter.resolveProject(event)).toBe(project);
		});

		it('returns null when the repo is untracked', async () => {
			vi.mocked(findProjectByRepo).mockResolvedValue(undefined);
			const event = parse('pull_request', {
				repository: { full_name: 'someone/else' },
				pull_request: { number: 1 },
			});
			expect(await adapter.resolveProject(event)).toBeNull();
		});
	});

	describe('isSelfAuthored (loop prevention)', () => {
		it('is true when the actor is a SWARM persona', async () => {
			vi.mocked(resolvePersonaIdentities).mockResolvedValue(IDENTITIES);
			vi.mocked(isSwarmBot).mockReturnValue(true);
			const event = parse('issue_comment', {
				repository: repo(),
				issue: { number: 1 },
				comment: {},
				sender: { login: 'swarm-rev' },
			});
			expect(await adapter.isSelfAuthored(event, project)).toBe(true);
			expect(isSwarmBot).toHaveBeenCalledWith('swarm-rev', IDENTITIES);
		});

		it('is false for a human actor', async () => {
			vi.mocked(resolvePersonaIdentities).mockResolvedValue(IDENTITIES);
			vi.mocked(isSwarmBot).mockReturnValue(false);
			const event = parse('issue_comment', {
				repository: repo(),
				issue: { number: 1 },
				comment: {},
				sender: { login: 'a-human' },
			});
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
		});

		it('is false when the event has no actor', async () => {
			const event = parse('check_suite', {
				repository: repo(),
				check_suite: { pull_requests: [{ number: 1 }] },
			});
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
			expect(resolvePersonaIdentities).not.toHaveBeenCalled();
		});

		it('is false for a lifecycle (non-comment) event even when a persona authored it', async () => {
			// The reviewer opening/acting on a PR must reach the implementer — this
			// drop gate must not fire for pull_request/pull_request_review events, so
			// it short-circuits before ever resolving identities.
			const event = parse('pull_request', {
				repository: repo(),
				pull_request: { number: 1 },
				sender: { login: 'swarm-impl' },
			});
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
			expect(resolvePersonaIdentities).not.toHaveBeenCalled();
			expect(isSwarmBot).not.toHaveBeenCalled();
		});

		it('fails safe to false (and does not throw) when identity resolution errors', async () => {
			vi.mocked(resolvePersonaIdentities).mockRejectedValue(new Error('no token'));
			const event = parse('issue_comment', {
				repository: repo(),
				issue: { number: 1 },
				comment: {},
				sender: { login: 'swarm-rev' },
			});
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
		});
	});

	describe('personaForEvent', () => {
		it('returns the persona that authored the event', () => {
			vi.mocked(getPersonaForLogin).mockReturnValue('reviewer');
			const event = parse('pull_request_review', {
				repository: repo(),
				pull_request: { number: 1 },
				sender: { login: 'swarm-rev' },
			});
			expect(adapter.personaForEvent(event, IDENTITIES)).toBe('reviewer');
		});

		it('returns null when there is no actor', () => {
			const event = parse('check_suite', {
				repository: repo(),
				check_suite: { pull_requests: [{ number: 1 }] },
			});
			expect(adapter.personaForEvent(event, IDENTITIES)).toBeNull();
			expect(getPersonaForLogin).not.toHaveBeenCalled();
		});
	});

	describe('dispatchWithPersona', () => {
		it("runs the handler within the persona's credential scope", async () => {
			const result = await adapter.dispatchWithPersona(project, 'implementer', async () => 'ran');
			expect(withPersonaCredentials).toHaveBeenCalledWith(
				project,
				'implementer',
				expect.any(Function),
			);
			expect(result).toBe('ran');
		});
	});
});
