// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { RunRow } from '@/types/runs.js';

const navigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigate,
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		projects: {
			list: {
				queryOptions: () => ({
					queryKey: ['projects.list'],
					queryFn: () => Promise.resolve([]),
				}),
			},
		},
	},
}));

import { RunsTable } from './runs-table.js';

const baseRun: RunRow = {
	id: 'run-1',
	projectId: 'proj-a',
	taskId: '42',
	workItemId: 'issue-42',
	workItemTitle: 'Fix the widget',
	workItemUrl: 'https://github.com/acme/widgets/issues/42',
	prNumber: null,
	prTitle: null,
	phase: 'implementation',
	engine: 'claude',
	model: 'claude-opus-4-8',
	reasoning: null,
	status: 'completed',
	reviewVerdict: null,
	reviewOrdinal: null,
	reviewAutomationOutcome: null,
	reviewMergeOutcome: null,
	reviewMergeMessage: null,
	exitCode: 0,
	timedOut: false,
	error: null,
	startedAt: '2026-07-17T10:00:00.000Z',
	completedAt: '2026-07-17T10:05:00.000Z',
	nextRetryAt: null,
	durationMs: 300000,
	usage: { inputTokens: 1000, outputTokens: 500 },
	jobPayload: null,
	agentSessionId: null,
	failureDiagnosis: null,
};

// The table resolves project names via `projects.list`; that query has no server
// here, so wrap in a QueryClient (retry off) and let it stay pending — the
// component falls back to the projectId, which is all these tests need.
function renderTable(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('RunsTable', () => {
	it('keeps every column and the key headers rather than dropping them for mobile', () => {
		renderTable(
			<RunsTable
				runs={[baseRun]}
				totalCount={1}
				currentPage={1}
				pageSize={25}
				onPageChange={vi.fn()}
			/>,
		);

		// The full desktop column set stays in the DOM at every width — the
		// responsive strategy is horizontal scroll, not a reduced column set.
		for (const header of [
			'Phase',
			'Project',
			'Task / ID',
			'Status',
			'Started',
			'Duration',
			'Model',
			'Tokens',
		]) {
			expect(screen.getByText(header)).not.toBeNull();
		}
	});

	it('lets the table scroll horizontally on mobile and restores full width on desktop', () => {
		const { container } = renderTable(
			<RunsTable
				runs={[baseRun]}
				totalCount={1}
				currentPage={1}
				pageSize={25}
				onPageChange={vi.fn()}
			/>,
		);

		const wrapper = container.querySelector('table')?.parentElement;
		expect(wrapper?.className).toContain('overflow-x-auto');
		// No clipping wrapper that would crush columns instead of scrolling.
		expect(wrapper?.className).not.toContain('overflow-hidden');

		const table = container.querySelector('table');
		expect(table?.className).toContain('table-fixed');
		expect(table?.className).toContain('min-w-[48rem]');
		expect(table?.className).toContain('md:min-w-full');
	});

	it('stacks the pagination footer on mobile and returns to a row on desktop', () => {
		renderTable(
			<RunsTable
				runs={[baseRun]}
				totalCount={100}
				currentPage={2}
				pageSize={25}
				onPageChange={vi.fn()}
			/>,
		);

		const footer = screen.getByText(/Showing/).closest('div')?.parentElement;
		expect(footer?.className).toContain('flex-col');
		expect(footer?.className).toContain('sm:flex-row');
		expect(footer?.className).toContain('sm:justify-between');
	});

	it('still drives pagination via onPageChange', () => {
		const onPageChange = vi.fn();
		renderTable(
			<RunsTable
				runs={[baseRun]}
				totalCount={100}
				currentPage={2}
				pageSize={25}
				onPageChange={onPageChange}
			/>,
		);

		fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
		expect(onPageChange).toHaveBeenCalledWith(1);

		fireEvent.click(screen.getByRole('button', { name: 'Next' }));
		expect(onPageChange).toHaveBeenCalledWith(3);
	});

	it('omits the Project column but keeps the same responsive contract when showProject is false', () => {
		const { container } = renderTable(
			<RunsTable
				runs={[baseRun]}
				totalCount={1}
				currentPage={1}
				pageSize={25}
				onPageChange={vi.fn()}
				showProject={false}
			/>,
		);

		const table = container.querySelector('table');
		expect(within(table as HTMLElement).queryByText('Project')).toBeNull();
		// The Task / ID, Status and Started columns — the priority fields — remain.
		expect(within(table as HTMLElement).getByText('Task / ID')).not.toBeNull();
		expect(within(table as HTMLElement).getByText('Status')).not.toBeNull();
		expect(within(table as HTMLElement).getByText('Started')).not.toBeNull();

		expect(table?.className).toContain('min-w-[48rem]');
		expect(table?.className).toContain('md:min-w-full');
	});
});
