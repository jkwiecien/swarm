// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRow } from '@/types/workers.js';

const { workersListQueryFn, projectsListQueryFn, workersQueryOptions } = vi.hoisted(() => ({
	workersListQueryFn: vi.fn(),
	projectsListQueryFn: vi.fn(),
	workersQueryOptions: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		workers: { list: { queryOptions: workersQueryOptions } },
		projects: {
			list: {
				queryOptions: () => ({ queryKey: ['projects.list'], queryFn: projectsListQueryFn }),
			},
		},
	},
}));

import { WORKERS_REFETCH_MS, WorkersRouteComponent, workersRoute } from './index.js';

function makeWorker(overrides: Partial<WorkerRow> = {}): WorkerRow {
	return {
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
		capabilities: ['claude'],
		connection: 'online',
		lastSeenAt: '2026-07-01T12:00:00.000Z',
		currentRunId: null,
		enrollments: [{ projectId: 'proj-a', status: 'active' }],
		...overrides,
	};
}

function renderScreen(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	workersListQueryFn.mockReset();
	projectsListQueryFn.mockReset();
	workersQueryOptions.mockReset();
	workersQueryOptions.mockReturnValue({
		queryKey: ['workers.list'],
		queryFn: workersListQueryFn,
	});
	projectsListQueryFn.mockReturnValue(new Promise(() => {}));
});

describe('/workers route registration', () => {
	it('is mounted at /workers', () => {
		// `path` is only populated on the route object once a router initializes it,
		// so read the configured value straight off the options.
		expect((workersRoute.options as { path?: string }).path).toBe('/workers');
	});

	it('polls well inside the 60s default heartbeat TTL, so offline surfaces promptly', () => {
		expect(WORKERS_REFETCH_MS).toBeGreaterThan(0);
		expect(WORKERS_REFETCH_MS).toBeLessThan(60_000);
	});
});

describe('Workers screen states', () => {
	it('shows a loading state while the roster is in flight', () => {
		workersListQueryFn.mockReturnValue(new Promise(() => {}));
		renderScreen(<WorkersRouteComponent />);

		expect(screen.getByText('Loading workers…')).toBeDefined();
	});

	it('surfaces the API error instead of an empty roster', async () => {
		workersListQueryFn.mockRejectedValue(new Error('Not authenticated'));
		renderScreen(<WorkersRouteComponent />);

		expect(await screen.findByText('Not authenticated')).toBeDefined();
	});

	it('shows an empty state that reads for both an empty installation and a viewer with no visible worker', async () => {
		workersListQueryFn.mockResolvedValue([]);
		renderScreen(<WorkersRouteComponent />);

		expect(await screen.findByText('No workers to show.')).toBeDefined();
		expect(screen.getByText(/enrolled in a project you can access/)).toBeDefined();
	});

	it('renders the roster once loaded, polling on the fixed short interval', async () => {
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderScreen(<WorkersRouteComponent />);

		expect(await screen.findByText('ada-laptop')).toBeDefined();
		expect(screen.getByText('Online')).toBeDefined();
	});

	it('exposes no controls — the screen is read-only', async () => {
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderScreen(<WorkersRouteComponent />);

		await screen.findByText('ada-laptop');
		expect(screen.queryAllByRole('button')).toHaveLength(0);
	});
});
