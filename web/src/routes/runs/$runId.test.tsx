// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunRow } from '@/types/runs.js';
import { ReviewCapCallout, ReviewMergeCallout } from './$runId.js';

function makeReviewRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: 'run-1',
		projectId: 'project-1',
		taskId: 'task-1',
		workItemId: null,
		workItemTitle: null,
		workItemUrl: null,
		prNumber: '42',
		prTitle: 'Some PR',
		phase: 'review',
		engine: 'claude',
		model: 'sonnet',
		reasoning: null,
		status: 'completed',
		reviewVerdict: 'request-changes',
		reviewOrdinal: 2,
		reviewAutomationOutcome: 'manual-intervention-required',
		reviewMergeOutcome: null,
		reviewMergeMessage: null,
		exitCode: 0,
		timedOut: false,
		error: null,
		startedAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:05:00.000Z',
		nextRetryAt: null,
		durationMs: 1000,
		usage: null,
		jobPayload: null,
		agentSessionId: null,
		...overrides,
	};
}

describe('ReviewCapCallout (issue #242)', () => {
	it('explains the cap-stopping second verdict and cites its ordinal', () => {
		render(
			<ReviewCapCallout run={makeReviewRun()} project={{ name: 'Demo', repo: 'acme/demo' }} />,
		);

		expect(screen.getByRole('heading', { name: 'Manual action required' })).toBeDefined();
		expect(screen.getByText(/second changes-requested verdict/i)).toBeDefined();
		expect(screen.getByText(/review 2 of 2/i)).toBeDefined();
		expect(screen.getByText(/will not automatically enqueue another/i)).toBeDefined();
	});

	it('links to the PR when the project repo is known', () => {
		render(
			<ReviewCapCallout run={makeReviewRun()} project={{ name: 'Demo', repo: 'acme/demo' }} />,
		);

		const link = screen.getByRole('link', { name: /view pr #42/i }) as HTMLAnchorElement;
		expect(link.href).toBe('https://github.com/acme/demo/pull/42');
	});

	it('omits the PR link when no project is known', () => {
		render(<ReviewCapCallout run={makeReviewRun()} project={null} />);

		expect(screen.getByRole('heading', { name: 'Manual action required' })).toBeDefined();
		expect(screen.queryByRole('link', { name: /view pr/i })).toBeNull();
	});

	it('renders nothing for an ordinary first changes-requested verdict', () => {
		const { container } = render(
			<ReviewCapCallout
				run={makeReviewRun({ reviewOrdinal: 1, reviewAutomationOutcome: null })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for an approval verdict even with the outcome field set', () => {
		const { container } = render(
			<ReviewCapCallout
				run={makeReviewRun({ reviewVerdict: 'approve' })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for a non-Review phase', () => {
		const { container } = render(
			<ReviewCapCallout
				run={makeReviewRun({ phase: 'respond-to-review' })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for a run still in progress', () => {
		const { container } = render(
			<ReviewCapCallout
				run={makeReviewRun({ status: 'running' })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});
});

describe('ReviewMergeCallout (issue #278)', () => {
	it('renders nothing when no merge automation ran', () => {
		const { container } = render(
			<ReviewMergeCallout
				run={makeReviewRun({ reviewMergeOutcome: null })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for a non-Review phase even with an outcome set', () => {
		const { container } = render(
			<ReviewMergeCallout
				run={makeReviewRun({ phase: 'respond-to-review', reviewMergeOutcome: 'merged' })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});

	it('shows a merged callout with the PR link', () => {
		render(
			<ReviewMergeCallout
				run={makeReviewRun({
					reviewMergeOutcome: 'merged',
					reviewMergeMessage: 'Pull Request successfully merged',
				})}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(screen.getByRole('heading', { name: 'Merged automatically' })).toBeDefined();
		expect(screen.getByText('Pull Request successfully merged')).toBeDefined();
		const link = screen.getByRole('link', { name: /view pr #42/i }) as HTMLAnchorElement;
		expect(link.href).toBe('https://github.com/acme/demo/pull/42');
	});

	it('shows a waiting callout for a not-ready outcome', () => {
		render(
			<ReviewMergeCallout
				run={makeReviewRun({
					reviewMergeOutcome: 'not-ready',
					reviewMergeMessage: 'required checks are still pending',
				})}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(
			screen.getByRole('heading', { name: /waiting — retrying automatically/i }),
		).toBeDefined();
		expect(screen.getByText('required checks are still pending')).toBeDefined();
	});

	it.each([
		['not-eligible', 'No longer eligible for automatic merge'],
		['policy-blocked', 'Blocked by repository policy'],
		['unsupported', 'Merge automation unsupported'],
		['provider-error', 'Merge automation hit a provider error'],
		['retry-exhausted', 'Automatic merge retry budget exhausted'],
	])('shows a terminal callout for %s', (outcome, heading) => {
		render(
			<ReviewMergeCallout
				run={makeReviewRun({ reviewMergeOutcome: outcome, reviewMergeMessage: 'details here' })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(screen.getByRole('heading', { name: heading })).toBeDefined();
		expect(screen.getByText('details here')).toBeDefined();
	});
});
