// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerWorker, WorkerRosterEntry, WorkerRow } from '@/types/workers.js';

const { projectsListQueryFn, listMineQueryFn, rosterQueryFn, setConsentMutate } = vi.hoisted(
	() => ({
		projectsListQueryFn: vi.fn(),
		listMineQueryFn: vi.fn(),
		rosterQueryFn: vi.fn(),
		setConsentMutate: vi.fn(),
	}),
);

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		projects: {
			list: {
				queryOptions: () => ({ queryKey: ['projects.list'], queryFn: projectsListQueryFn }),
			},
		},
		workers: {
			listMine: {
				queryOptions: () => ({ queryKey: ['workers.listMine'], queryFn: listMineQueryFn }),
			},
			roster: {
				queryOptions: (input: { projectId: string }) => ({
					queryKey: ['workers.roster', input],
					queryFn: () => rosterQueryFn(input),
				}),
			},
		},
	},
	trpcClient: {
		workers: { setConsent: { mutate: setConsentMutate } },
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

function makeRosterEntry(overrides: Partial<WorkerRosterEntry> = {}): WorkerRosterEntry {
	return {
		enrollmentId: 'enr-1',
		workerId: 'worker-1',
		projectId: 'proj-a',
		displayName: 'ada-laptop',
		owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
		capabilities: ['claude', 'codex'],
		status: 'active',
		allowedClis: ['claude'],
		concurrencyAllocation: 1,
		sharingConsent: true,
		isRoutable: true,
		runState: { busy: false, currentRunId: null },
		...overrides,
	};
}

function makeOwnerWorker(overrides: Partial<OwnerWorker> = {}): OwnerWorker {
	return {
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		capabilities: ['claude', 'codex'],
		runState: { busy: false, currentRunId: null },
		enrollments: [
			{
				enrollmentId: 'enr-1',
				projectId: 'proj-a',
				status: 'active',
				allowedClis: ['claude'],
				concurrencyAllocation: 1,
				sharingConsent: true,
				isRoutable: true,
			},
		],
		...overrides,
	};
}

// The table resolves project names via `projects.list`, its own enrollments via
// `workers.listMine`, and per-project consent via `workers.roster`. Wrap in a
// QueryClient (retry off). By default `projects.list` stays pending (raw id
// fallback) and the owner/roster queries are empty so no control renders — each
// test overrides only what it exercises.
function renderTable(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	projectsListQueryFn.mockReset();
	listMineQueryFn.mockReset();
	rosterQueryFn.mockReset();
	setConsentMutate.mockReset();
	projectsListQueryFn.mockReturnValue(new Promise(() => {}));
	listMineQueryFn.mockResolvedValue([]);
	rosterQueryFn.mockResolvedValue([]);
	// Fake only `Date` (fixes `formatRelativeTime`'s "now") so setTimeout stays
	// real and Testing Library's async `findBy*`/`waitFor` resolve normally.
	vi.useFakeTimers({ toFake: ['Date'] });
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

describe('WorkersTable sharing consent (issue #282)', () => {
	it('shows an owner an actionable switch and the available/routable state', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);
		rosterQueryFn.mockResolvedValue([makeRosterEntry()]);
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		expect(await screen.findByText('Available to this project')).toBeDefined();
		const toggle = await screen.findByRole('switch', {
			name: 'Share ada-laptop with proj-a',
		});
		expect(toggle.getAttribute('aria-checked')).toBe('true');
		// Effective allowed CLIs for the project are shown nearby.
		expect(screen.getByTitle('Effective allowed CLIs for this project')).toBeDefined();
	});

	it('enables sharing directly, with the exact payload and the resulting routable state', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({
				enrollments: [
					{
						enrollmentId: 'enr-1',
						projectId: 'proj-a',
						status: 'active',
						allowedClis: ['claude'],
						concurrencyAllocation: 1,
						sharingConsent: false,
						isRoutable: false,
					},
				],
			}),
		]);
		// Initial roster shows consent off; the post-mutation reconcile refetch is
		// left pending so the assertion targets the immediately-effective optimistic
		// cache update rather than a re-resolved mock.
		rosterQueryFn
			.mockResolvedValueOnce([makeRosterEntry({ sharingConsent: false, isRoutable: false })])
			.mockReturnValue(new Promise(() => {}));
		setConsentMutate.mockResolvedValue({
			id: 'enr-1',
			workerId: 'worker-1',
			projectId: 'proj-a',
			status: 'active',
			allowedClis: ['claude'],
			concurrencyAllocation: 1,
			sharingConsent: true,
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
		});
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		expect(await screen.findByText('Not sharing')).toBeDefined();
		const toggle = await screen.findByRole('switch', {
			name: 'Share ada-laptop with proj-a',
		});
		expect(toggle.getAttribute('aria-checked')).toBe('false');

		fireEvent.click(toggle);

		// No confirmation for enabling — the mutation fires directly.
		expect(screen.queryByText('Stop sharing this worker?')).toBeNull();
		expect(await screen.findByText('Available to this project')).toBeDefined();
		expect(setConsentMutate).toHaveBeenCalledWith({
			enrollmentId: 'enr-1',
			sharingConsent: true,
		});
	});

	it('confirms before disabling and never mutates until confirmed', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);
		rosterQueryFn.mockResolvedValueOnce([makeRosterEntry()]).mockReturnValue(new Promise(() => {}));
		setConsentMutate.mockResolvedValue({
			id: 'enr-1',
			workerId: 'worker-1',
			projectId: 'proj-a',
			status: 'active',
			allowedClis: ['claude'],
			concurrencyAllocation: 1,
			sharingConsent: false,
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
		});
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		const toggle = await screen.findByRole('switch', {
			name: 'Share ada-laptop with proj-a',
		});
		fireEvent.click(toggle);

		// A confirmation opens explaining the consequence; no mutation yet.
		const dialogCopy = await screen.findByText(/future automatic dispatch/i);
		expect(dialogCopy).toBeDefined();
		expect(screen.getByText(/does not stop a run already in progress/i)).toBeDefined();
		expect(setConsentMutate).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

		// Immediately effective: the row flips to non-routable before reconciliation.
		expect(await screen.findByText('Not sharing')).toBeDefined();
		expect(setConsentMutate).toHaveBeenCalledWith({
			enrollmentId: 'enr-1',
			sharingConsent: false,
		});
	});

	it('keeps an active run visible after sharing is disabled (routing state effective immediately, run untouched)', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({ runState: { busy: true, currentRunId: 'run-9' } }),
		]);
		rosterQueryFn
			.mockResolvedValueOnce([makeRosterEntry({ runState: { busy: true, currentRunId: 'run-9' } })])
			.mockReturnValue(new Promise(() => {}));
		setConsentMutate.mockResolvedValue({
			id: 'enr-1',
			workerId: 'worker-1',
			projectId: 'proj-a',
			status: 'active',
			allowedClis: ['claude'],
			concurrencyAllocation: 1,
			sharingConsent: false,
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
		});
		renderTable(<WorkersTable workers={[makeWorker({ currentRunId: 'run-9' })]} />);

		fireEvent.click(await screen.findByRole('switch', { name: 'Share ada-laptop with proj-a' }));
		fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

		expect(await screen.findByText('Not sharing')).toBeDefined();
		// The in-flight run link is still shown — disabling sharing never kills it.
		expect(screen.getByRole('link', { name: 'run-9' })).toBeDefined();
		expect(screen.getAllByText('Busy').length).toBeGreaterThan(0);
	});

	it('shows a project admin another owner’s revoked-sharing state with no control', async () => {
		// The viewer owns nothing (listMine empty) but can read the project roster,
		// where the worker's owner has consent off.
		listMineQueryFn.mockResolvedValue([]);
		rosterQueryFn.mockResolvedValue([
			makeRosterEntry({
				owner: { userId: 'u2', identifier: 'grace@example.com', displayName: 'Grace Hopper' },
				sharingConsent: false,
				isRoutable: false,
			}),
		]);
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		expect(await screen.findByText('Not sharing')).toBeDefined();
		expect(screen.queryByRole('switch')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Stop sharing' })).toBeNull();
	});

	it('leaves consent unchanged and surfaces the error inline when an enable is rejected', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({
				enrollments: [
					{
						enrollmentId: 'enr-1',
						projectId: 'proj-a',
						status: 'active',
						allowedClis: ['claude'],
						concurrencyAllocation: 1,
						sharingConsent: false,
						isRoutable: false,
					},
				],
			}),
		]);
		rosterQueryFn.mockResolvedValue([
			makeRosterEntry({ sharingConsent: false, isRoutable: false }),
		]);
		setConsentMutate.mockRejectedValue(new Error('Enrollment with ID "enr-1" not found'));
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		const toggle = await screen.findByRole('switch', {
			name: 'Share ada-laptop with proj-a',
		});
		fireEvent.click(toggle);

		expect(await screen.findByText('Enrollment with ID "enr-1" not found')).toBeDefined();
		// The displayed state never falsely flipped to available.
		expect(screen.getByText('Not sharing')).toBeDefined();
		expect(
			(await screen.findByRole('switch', { name: 'Share ada-laptop with proj-a' })).getAttribute(
				'aria-checked',
			),
		).toBe('false');
	});
});

describe('WorkersTable read-only surface for non-owners', () => {
	it('offers no consent control when the viewer owns no worker', async () => {
		listMineQueryFn.mockResolvedValue([]);
		rosterQueryFn.mockResolvedValue([makeRosterEntry()]);
		renderTable(<WorkersTable workers={[makeWorker({ currentRunId: 'run-7' })]} />);

		await screen.findByText('Available to this project');
		expect(screen.queryAllByRole('switch')).toHaveLength(0);
		expect(screen.queryAllByRole('textbox')).toHaveLength(0);
		expect(screen.queryAllByRole('combobox')).toHaveLength(0);
		// Only the run link is interactive.
		const table = screen.getAllByRole('row')[1];
		expect(within(table).getAllByRole('link')).toHaveLength(1);
	});
});

describe('WorkersTable polling and delayed/error roster query behavior', () => {
	it('polls supplemental queries and updates both Busy/Idle and sharing availability on cadence', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);
		// The next roster response flips two independent server-derived facts at
		// once: run state (Idle -> Busy) and routability (routable/"Available to
		// this project" -> consent-off/"Not sharing"). Both must reflect on the
		// polled cadence without the row remounting.
		rosterQueryFn
			.mockResolvedValueOnce([
				makeRosterEntry({
					sharingConsent: true,
					isRoutable: true,
					runState: { busy: false, currentRunId: null },
				}),
			])
			.mockResolvedValueOnce([
				makeRosterEntry({
					sharingConsent: false,
					isRoutable: false,
					runState: { busy: true, currentRunId: 'run-9' },
				}),
			]);

		renderTable(<WorkersTable workers={[makeWorker()]} refetchInterval={100} />);

		// Initial roster response: idle and available to this project.
		const initialRow = (await screen.findByText('ada-laptop')).closest('tr');
		expect(await screen.findByText('Idle')).toBeDefined();
		expect(screen.getByText('Available to this project')).toBeDefined();
		expect(screen.queryByText('Busy')).toBeNull();
		expect(screen.queryByText('Not sharing')).toBeNull();

		// After the poll interval, the second roster response updates both the
		// Busy/Idle indicator and the sharing-availability label. findByText waits
		// for the refetch-driven re-render.
		expect(await screen.findByText('Busy')).toBeDefined();
		expect(await screen.findByText('Not sharing')).toBeDefined();
		expect(screen.queryByText('Idle')).toBeNull();
		expect(screen.queryByText('Available to this project')).toBeNull();

		// Same row element throughout — the update was a refetch, not a remount.
		expect((await screen.findByText('ada-laptop')).closest('tr')).toBe(initialRow);
		// The owner query (workers.listMine) refetches on the same cadence too.
		expect(listMineQueryFn.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it('withholds the switch and shows sharing state unavailable when roster query is delayed', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({
				enrollments: [
					{
						enrollmentId: 'enr-1',
						projectId: 'proj-a',
						status: 'active',
						allowedClis: ['claude'],
						concurrencyAllocation: 1,
						sharingConsent: true,
						isRoutable: true,
					},
				],
			}),
		]);
		// Definite-assignment assertion: the Promise executor runs synchronously,
		// so `resolveRoster` is assigned before any code below invokes it — but
		// TypeScript can't prove that through the closure, so assert it.
		let resolveRoster!: (value: WorkerRosterEntry[]) => void;
		const rosterPromise = new Promise<WorkerRosterEntry[]>((resolve) => {
			resolveRoster = resolve;
		});
		rosterQueryFn.mockReturnValue(rosterPromise);

		renderTable(<WorkersTable workers={[makeWorker()]} />);

		// Since listMine resolved, the row shows. But roster is pending.
		// Control should be withheld, and "Sharing state unavailable" should be shown.
		expect(await screen.findByText('Sharing state unavailable')).toBeDefined();
		expect(screen.queryByRole('switch')).toBeNull();

		// Now resolve the roster query
		resolveRoster([makeRosterEntry({ sharingConsent: true, isRoutable: true })]);

		// The switch should appear and be checked
		const toggle = await screen.findByRole('switch', {
			name: 'Share ada-laptop with proj-a',
		});
		expect(toggle.getAttribute('aria-checked')).toBe('true');
		expect(screen.queryByText('Sharing state unavailable')).toBeNull();
		expect(screen.getByText('Available to this project')).toBeDefined();
	});

	it('withholds the switch and shows sharing state unavailable when roster query fails', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);
		rosterQueryFn.mockRejectedValue(new Error('Roster query failed'));

		renderTable(<WorkersTable workers={[makeWorker()]} />);

		// Should show sharing state unavailable and withhold control
		expect(await screen.findByText('Sharing state unavailable')).toBeDefined();
		expect(screen.queryByRole('switch')).toBeNull();
	});
});
