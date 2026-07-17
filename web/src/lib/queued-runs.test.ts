import { describe, expect, it } from 'vitest';
import type { QueuedRun } from '@/types/runs.js';
import { queuedPhaseLabel, queuedRunKey, queuedWorkItemLabel, shortNodeId } from './queued-runs.js';

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
		expect(queuedWorkItemLabel(githubRun())).toBe('acme/widgets #42');
	});

	it('falls back to #<n> for a github job missing its repo', () => {
		expect(queuedWorkItemLabel(githubRun({ repo: undefined }))).toBe('#42');
	});

	it('renders a github-projects job as contentType · shortNodeId', () => {
		expect(queuedWorkItemLabel(boardRun())).toBe('Issue · …abc123');
	});

	it('shows just the short node id when the content type is absent', () => {
		expect(queuedWorkItemLabel(boardRun({ contentType: undefined }))).toBe('…abc123');
	});

	it('degrades to a generic label when all board fields are absent', () => {
		expect(
			queuedWorkItemLabel(boardRun({ contentType: undefined, workItemNodeId: undefined })),
		).toBe('Board item');
	});
});

describe('shortNodeId', () => {
	it('returns short ids unchanged', () => {
		expect(shortNodeId('abc123')).toBe('abc123');
	});

	it('truncates a long opaque id to a stable tail', () => {
		expect(shortNodeId('PVTI_lADODb1Ycc4Bcnwuzabc123')).toBe('…abc123');
	});
});

describe('queuedRunKey', () => {
	it('is the BullMQ job id', () => {
		expect(queuedRunKey(githubRun({ jobId: 'unique-job-id' }))).toBe('unique-job-id');
	});
});
