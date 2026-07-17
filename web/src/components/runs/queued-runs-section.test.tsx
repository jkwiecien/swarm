// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { QueuedRun } from '@/types/runs.js';
import { QueuedRunsSection } from './queued-runs-section.js';
import { RunStatusBadge } from './run-status-badge.js';

const githubItem: QueuedRun = {
	jobId: 'job-1',
	projectId: 'proj-a',
	type: 'github',
	state: 'waiting',
	phaseHint: 'review',
	repo: 'acme/widgets',
	prNumber: '42',
	priority: 0,
	enqueuedAt: '2026-07-17T10:00:00.000Z',
};

const boardItem: QueuedRun = {
	jobId: 'job-2',
	projectId: 'proj-a',
	type: 'github-projects',
	state: 'delayed',
	phaseHint: 'board',
	workItemNodeId: 'PVTI_lADODb1Ycc4Bcnwuzabc123',
	contentType: 'Issue',
	workItemTitle: 'Fix the widget',
	workItemUrl: 'https://github.com/acme/widgets/issues/42',
	priority: 5,
	// Enqueued *earlier* than the github item on purpose (see the ordering test).
	enqueuedAt: '2026-07-17T09:00:00.000Z',
	runsAt: '2026-07-17T12:00:00.000Z',
};

// The section resolves project names via `projects.list`; that query has no
// server here, so wrap in a QueryClient (retry off) and let it stay pending —
// the component falls back to the projectId, which is all these tests need.
function renderSection(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('QueuedRunsSection', () => {
	it('renders no section when there are no queued items', () => {
		const { container } = renderSection(<QueuedRunsSection items={[]} />);
		expect(container.firstChild).toBeNull();
		expect(screen.queryByTestId('queued-runs-section')).toBeNull();
	});

	it('renders a row per item with the right phase label and Task / ID reference', () => {
		renderSection(<QueuedRunsSection items={[githubItem, boardItem]} />);
		const section = screen.getByTestId('queued-runs-section');

		expect(within(section).getByText('Review')).not.toBeNull();
		expect(within(section).getByText(/PR #42/)).not.toBeNull();
		expect(within(section).getByText('Board (Planning/Impl)')).not.toBeNull();
		expect(within(section).getByText('Fix the widget')).not.toBeNull();
		expect(within(section).getByText('Issue: #42')).not.toBeNull();
		expect(within(section).getByText('Task / ID')).not.toBeNull();
	});

	it('preserves the server-provided order (no client-side re-sort)', () => {
		// Passed github-first even though the board item was enqueued earlier; a
		// client re-sort by enqueue time would swap them. Ordering is the server's.
		renderSection(<QueuedRunsSection items={[githubItem, boardItem]} />);
		const section = screen.getByTestId('queued-runs-section');
		const bodyRows = within(section).getAllByRole('row').slice(1); // drop the header row

		expect(bodyRows).toHaveLength(2);
		expect(within(bodyRows[0]).getByText(/PR #42/)).not.toBeNull();
		expect(within(bodyRows[1]).getByText('Issue: #42')).not.toBeNull();
	});

	it('shows when a delayed item will run', () => {
		renderSection(<QueuedRunsSection items={[boardItem]} />);
		const section = screen.getByTestId('queued-runs-section');
		expect(within(section).getByText(/runs/)).not.toBeNull();
	});

	it('shows a Queued badge that is visually distinct from a running badge (no pulse)', () => {
		renderSection(
			<>
				<QueuedRunsSection items={[githubItem]} />
				<RunStatusBadge status="running" />
			</>,
		);

		// The badge element (not the header/column labels) is the one with the
		// pill classes; its status dot must not pulse.
		const queuedBadges = screen
			.getAllByText('Queued')
			.filter((el) => el.className.includes('rounded'));
		expect(queuedBadges).toHaveLength(1);
		expect(queuedBadges[0].querySelector('span')?.className).not.toContain('animate-pulse');

		const runningDot = screen.getByText('Running').querySelector('span');
		expect(runningDot?.className).toContain('animate-pulse');
	});
});
