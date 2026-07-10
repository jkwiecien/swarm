import { useQuery } from '@tanstack/react-query';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { Play } from 'lucide-react';
import { z } from 'zod';
import { RunFilters } from '@/components/runs/run-filters.js';
import { RunsTable } from '@/components/runs/runs-table.js';
import { trpc } from '@/lib/trpc.js';
import { rootRoute } from '../__root.js';

const PAGE_SIZE = 20;

const runsSearchSchema = z.object({
	projectId: z.string().optional(),
	status: z.enum(['running', 'completed', 'failed', 'deferred']).optional(),
	phase: z
		.enum(['planning', 'implementation', 'review', 'respond-to-review', 'respond-to-ci'])
		.optional(),
	page: z.number().int().positive().optional(),
});

type RunsSearch = z.infer<typeof runsSearchSchema>;

interface EmptyRunsStateProps {
	hasFilters: boolean;
	onClear: () => void;
}

function EmptyRunsState({ hasFilters, onClear }: EmptyRunsStateProps) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-zinc-800 bg-[#0F0F11]/40 p-12 text-center shadow-sm">
			<Play className="h-12 w-12 stroke-1 text-zinc-700" />
			<p className="text-sm text-zinc-400">No pipeline runs found.</p>
			{hasFilters ? (
				<button
					type="button"
					onClick={onClear}
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors mt-2 cursor-pointer"
				>
					Clear Filters
				</button>
			) : (
				<p className="text-xs text-zinc-500">
					Run pipeline tasks from your terminal to see them listed here.
				</p>
			)}
		</div>
	);
}

function RunsRouteComponent() {
	const search = runsIndexRoute.useSearch() as RunsSearch;
	const navigate = useNavigate({ from: '/runs' });
	const currentPage = search.page ?? 1;

	const handleFilterChange = (updates: Partial<RunsSearch>) => {
		navigate({
			search: (old) => {
				const next = { ...old, ...updates };
				if (!('page' in updates)) {
					next.page = undefined;
				}
				return next;
			},
		});
	};

	const handleClearFilters = () => {
		navigate({
			search: () => ({}),
		});
	};

	const runsQuery = useQuery({
		...trpc.runs.list.queryOptions({
			projectId: search.projectId || undefined,
			status: search.status || undefined,
			phase: search.phase || undefined,
			limit: PAGE_SIZE,
			offset: (currentPage - 1) * PAGE_SIZE,
		}),
		refetchInterval: (query) => {
			const data = query.state.data;
			return data?.data?.some((run) => run.status === 'running') ? 2000 : false;
		},
	});

	const hasActiveFilters = !!(search.projectId || search.status || search.phase);

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Runs History</h1>
			</div>

			<RunFilters
				projectId={search.projectId}
				status={search.status}
				phase={search.phase}
				onProjectIdChange={(projectId) => handleFilterChange({ projectId })}
				onStatusChange={(status) => handleFilterChange({ status: status as RunsSearch['status'] })}
				onPhaseChange={(phase) => handleFilterChange({ phase: phase as RunsSearch['phase'] })}
				onClear={handleClearFilters}
			/>

			{runsQuery.isLoading ? (
				<div className="text-sm text-zinc-400">Loading runs history…</div>
			) : runsQuery.isError ? (
				<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{runsQuery.error.message}
				</div>
			) : runsQuery.data && runsQuery.data.data.length > 0 ? (
				<RunsTable
					runs={runsQuery.data.data}
					totalCount={runsQuery.data.total}
					currentPage={currentPage}
					pageSize={PAGE_SIZE}
					onPageChange={(page) => handleFilterChange({ page })}
				/>
			) : (
				<EmptyRunsState hasFilters={hasActiveFilters} onClear={handleClearFilters} />
			)}
		</div>
	);
}

export const runsIndexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/runs',
	validateSearch: (search) => runsSearchSchema.parse(search),
	component: RunsRouteComponent,
});
