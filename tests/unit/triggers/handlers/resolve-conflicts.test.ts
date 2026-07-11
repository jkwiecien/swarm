import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockProjectConfig } from '../../../helpers/factories.js';

const {
	listConflictCandidates,
	commentOnPullRequest,
	scheduleCoalescedJob,
	claimConflictResolution,
} = vi.hoisted(() => ({
	listConflictCandidates: vi.fn(),
	commentOnPullRequest: vi.fn(),
	scheduleCoalescedJob: vi.fn(),
	claimConflictResolution: vi.fn(),
}));

vi.mock('@/integrations/scm/github/scm-integration.js', () => ({
	GitHubSCMIntegration: class {
		listConflictCandidates = listConflictCandidates;
		commentOnPullRequest = commentOnPullRequest;
	},
}));
vi.mock('@/integrations/scm/github/personas.js', () => ({
	resolvePersonaIdentities: vi.fn(async () => ({
		implementer: 'swarm-impl',
		reviewer: 'swarm-rev',
	})),
	isSwarmBot: vi.fn((login: string) => login.startsWith('swarm-')),
}));
vi.mock('@/queue/producer.js', () => ({ scheduleCoalescedJob }));
vi.mock('@/triggers/resolve-conflicts-dedup.js', () => ({ claimConflictResolution }));

import { createResolveConflictsTrigger } from '@/triggers/handlers/resolve-conflicts.js';

const project = createMockProjectConfig({ repo: 'acme/widgets' });
const mergedEvent = {
	project,
	source: 'github' as const,
	event: {
		eventType: 'pull_request' as const,
		action: 'closed',
		repoFullName: project.repo,
		isCommentEvent: false,
		merged: true,
		baseBranch: 'main',
	},
};
const candidate = {
	number: 42,
	headBranch: 'issue-42',
	headSha: 'head123',
	baseBranch: 'main',
	baseSha: 'base456',
	mergeable: false,
	authorLogin: 'swarm-impl',
};

describe('resolve-conflicts trigger', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listConflictCandidates.mockResolvedValue([candidate]);
		claimConflictResolution.mockResolvedValue(true);
		scheduleCoalescedJob.mockResolvedValue(undefined);
	});

	it('matches only a merged pull_request.closed event', () => {
		const trigger = createResolveConflictsTrigger();
		expect(trigger.matches(mergedEvent)).toBe(true);
		expect(
			trigger.matches({ ...mergedEvent, event: { ...mergedEvent.event, merged: false } }),
		).toBe(false);
	});

	it('fans out candidate checks without dispatching speculatively', async () => {
		const result = await createResolveConflictsTrigger().handle(mergedEvent);
		expect(result).toBeNull();
		expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
	});

	it('dispatches only a confirmed conflict and claims its head/base state', async () => {
		const result = await createResolveConflictsTrigger().handle({
			...mergedEvent,
			event: { ...mergedEvent.event, conflictPrNumber: '42' },
		});
		expect(claimConflictResolution).toHaveBeenCalledWith('acme/widgets:42:head123:base456');
		expect(result).toMatchObject({
			phase: 'resolve-conflicts',
			prNumber: '42',
			taskId: '42-conflicts',
		});
	});

	it('does not dispatch a clean or merely behind PR', async () => {
		listConflictCandidates.mockResolvedValue([{ ...candidate, mergeable: true }]);
		const result = await createResolveConflictsTrigger().handle({
			...mergedEvent,
			event: { ...mergedEvent.event, conflictPrNumber: '42' },
		});
		expect(result).toBeNull();
		expect(claimConflictResolution).not.toHaveBeenCalled();
	});

	it('coalesces a delayed retry while mergeability is unknown', async () => {
		listConflictCandidates.mockResolvedValue([{ ...candidate, mergeable: null }]);
		const result = await createResolveConflictsTrigger().handle({
			...mergedEvent,
			event: { ...mergedEvent.event, conflictPrNumber: '42' },
		});
		expect(result).toBeNull();
		expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
	});
});
