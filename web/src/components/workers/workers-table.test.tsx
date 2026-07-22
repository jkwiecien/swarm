// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRow } from '@/types/workers.js';

const { projectsListQueryFn } = vi.hoisted(() => ({ projectsListQueryFn: vi.fn() }));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		projects: {
			list: {
				queryOptions: () => ({ queryKey: ['projects.list'], queryFn: projectsListQueryFn }),
			},
		},
	},
}));

import { WorkersTable } from './workers-table.js';

const NOW = new Date('2026-07-01T12:00:00.000Z');

function makeWorker(overrides: Partial<WorkerRow> = {}): WorkerRow {
	return {
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
		capabilities: ['claude', 'codex'],
		connection: 'online',
		lastSeenAt: NOW.toISOString(),
		currentRunId: null,
		enrollments: [{ projectId: 'proj-a', status: 'active' }],
		...overrides,
	};
}

// The table resolves project names via `projects.list`; that query has no server
// here, so wrap in a QueryClient (retry off) and let it stay pending unless a
// test resolves it — the component then falls back to the raw project id.
function renderTable(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	projectsListQueryFn.mockReset();
	projectsListQueryFn.mockReturnValue(new Promise(() => {}));
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('WorkersTable connectivity (issue #133)', () => {
	it('shows a connected worker as Online', () => {
		renderTable(<WorkersTable workers={[makeWorker()]} />);
		expect(screen.getByText('Online')).toBeDefined();
	});

	it('shows an offline worker with a relative last-seen time and the exact timestamp as a title', () => {
		const lastSeenAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();
		renderTable(<WorkersTable workers={[makeWorker({ connection: 'offline', lastSeenAt })]} />);

		expect(screen.getByText('Offline')).toBeDefined();
		const relative = screen.getByText('· 5m ago');
		expect(relative.getAttribute('title')).toBe(new Date(lastSeenAt).toLocaleString());
	});

	it('says a worker that never connected has no last-seen value', () => {
		renderTable(
			<WorkersTable workers={[makeWorker({ connection: 'offline', lastSeenAt: null })]} />,
		);

		const never = screen.getByText('· Never connected');
		expect(never.getAttribute('title')).toBeNull();
	});
});

describe('WorkersTable row content', () => {
	it('renders the machine name, owner, and declared CLI capabilities', () => {
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		expect(screen.getByText('ada-laptop')).toBeDefined();
		expect(screen.getByText('Ada Lovelace').getAttribute('title')).toBe('ada@example.com');
		expect(screen.getByText('claude')).toBeDefined();
		expect(screen.getByText('codex')).toBeDefined();
	});

	it('links an in-flight run to its detail page', () => {
		renderTable(<WorkersTable workers={[makeWorker({ currentRunId: 'run-7' })]} />);

		const link = screen.getByRole('link', { name: 'run-7' });
		expect(link.getAttribute('href')).toBe('/runs/run-7');
	});

	it('renders an em dash when the worker has no visible in-flight run', () => {
		renderTable(<WorkersTable workers={[makeWorker({ currentRunId: null })]} />);

		expect(screen.queryByRole('link')).toBeNull();
		expect(screen.getAllByText('—').length).toBeGreaterThan(0);
	});

	it('renders one row per worker', () => {
		renderTable(
			<WorkersTable
				workers={[makeWorker(), makeWorker({ workerId: 'worker-2', displayName: 'grace-box' })]}
			/>,
		);

		const bodyRows = screen.getAllByRole('row').slice(1); // drop the header row
		expect(bodyRows).toHaveLength(2);
	});
});

describe('WorkersTable enrollment states', () => {
	it('labels each visible enrollment with its approval state', () => {
		renderTable(
			<WorkersTable
				workers={[
					makeWorker({
						enrollments: [
							{ projectId: 'proj-a', status: 'active' },
							{ projectId: 'proj-b', status: 'pending' },
							{ projectId: 'proj-c', status: 'suspended' },
						],
					}),
				]}
			/>,
		);

		expect(screen.getByText('Active')).toBeDefined();
		expect(screen.getByText('Pending')).toBeDefined();
		expect(screen.getByText('Suspended')).toBeDefined();
	});

	it('falls back to the project id when the project-name lookup is unavailable', () => {
		renderTable(<WorkersTable workers={[makeWorker()]} />);
		expect(screen.getByText('proj-a')).toBeDefined();
	});

	it('shows a registered-but-un-enrolled machine as Not enrolled', () => {
		renderTable(<WorkersTable workers={[makeWorker({ enrollments: [] })]} />);
		expect(screen.getByText('Not enrolled')).toBeDefined();
	});
});

describe('WorkersTable is read-only', () => {
	it('offers no buttons, forms, or inputs — only the run link', () => {
		renderTable(<WorkersTable workers={[makeWorker({ currentRunId: 'run-7' })]} />);

		expect(screen.queryAllByRole('button')).toHaveLength(0);
		expect(screen.queryAllByRole('textbox')).toHaveLength(0);
		expect(screen.queryAllByRole('combobox')).toHaveLength(0);
		expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
		expect(screen.getAllByRole('link')).toHaveLength(1);
	});
});
