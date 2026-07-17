import { describe, expect, it } from 'vitest';
import type { QueuedRun } from '@/types/runs.js';
import {
	queuedPhaseLabel,
	queuedRunKey,
	queuedWorkItemLabel,
	queuedWorkItemTitle,
	queuedWorkItemUrl,
} from './queued-runs.js';

function githubRun(overrides: Partial<QueuedRun> = {}): QueuedRun {
	return {
		jobId: 'job-gh',
		projectId: 'proj',
		type: 'github',
		state: 'waiting',
		phaseHint: 'review',
		repo: 'acme/widgets',
		prNumber: '42',
		priority: 0,
		enqueuedAt: '2026-07-17T10:00:00.000Z',
		...overrides,
	};
}

function boardRun(overrides: Partial<QueuedRun> = {}): QueuedRun {
	return {
		jobId: 'job-board',
		projectId: 'proj',
		type: 'github-projects',
		state: 'delayed',
		phaseHint: 'board',
		workItemNodeId: 'PVTI_lADODb1Ycc4Bcnwuzabc123',
		contentType: 'Issue',
		workItemTitle: 'Fix the widget',
		workItemUrl: 'https://github.com/acme/widgets/issues/42',
		priority: 5,
		enqueuedAt: '2026-07-17T09:00:00.000Z',
		runsAt: '2026-07-17T12:00:00.000Z',
		...overrides,
	};
}

describe('queuedPhaseLabel', () => {
	it.each([
		['board', 'Board (Planning/Impl)'],
		['review', 'Review'],
		['respond-to-review', 'Respond to review'],
		['respond-to-ci', 'Respond to CI'],
		['resolve-conflicts', 'Resolve conflicts'],
		['unknown', 'Unknown'],
	] as const)('labels %s as "%s"', (hint, label) => {
		expect(queuedPhaseLabel(hint)).toBe(label);
	});
});

describe('queuedWorkItemLabel', () => {
	it('renders a github job as owner/repo #<n>', () => {
		expect(queuedWorkItemLabel(githubRun())).toBe('PR #42');
	});

	it('falls back to #<n> for a github job missing its repo', () => {
		expect(queuedWorkItemLabel(githubRun({ repo: undefined }))).toBe('PR #42');
	});

	it('renders a resolved github-projects job using the persisted run label rules', () => {
		expect(queuedWorkItemLabel(boardRun())).toBe('Issue: #42');
		expect(queuedWorkItemTitle(boardRun())).toBe('Fix the widget');
		expect(queuedWorkItemUrl(githubRun())).toBe('https://github.com/acme/widgets/pull/42');
		expect(queuedWorkItemUrl(boardRun())).toBe('https://github.com/acme/widgets/issues/42');
	});

	it('does not expose an opaque board node id when metadata is unavailable', () => {
		expect(
			queuedWorkItemLabel(
				boardRun({
					contentType: undefined,
					workItemNodeId: undefined,
					workItemTitle: undefined,
					workItemUrl: undefined,
				}),
			),
		).toBe('—');
	});

	it('uses an em dash when a board item cannot be resolved', () => {
		expect(queuedWorkItemLabel(boardRun({ workItemUrl: undefined }))).toBe('—');
	});
});

describe('queuedRunKey', () => {
	it('is the BullMQ job id', () => {
		expect(queuedRunKey(githubRun({ jobId: 'unique-job-id' }))).toBe('unique-job-id');
	});
});
