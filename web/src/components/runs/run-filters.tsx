import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { trpc } from '@/lib/trpc.js';

interface RunFiltersProps {
	projectId?: string;
	status?: string;
	phase?: string;
	onProjectIdChange: (id: string | undefined) => void;
	onStatusChange: (status: string | undefined) => void;
	onPhaseChange: (phase: string | undefined) => void;
	onClear: () => void;
}

export function RunFilters({
	projectId,
	status,
	phase,
	onProjectIdChange,
	onStatusChange,
	onPhaseChange,
	onClear,
}: RunFiltersProps) {
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());

	const hasActiveFilters = projectId || status || phase;

	return (
		<div className="flex flex-wrap items-end gap-4 p-4 border border-zinc-800 rounded-lg bg-[#0F0F11]/40 shadow-sm">
			<div className="flex-1 min-w-[200px]">
				<label htmlFor="filter-project" className="block text-xs font-medium text-zinc-400 mb-1.5">
					Project
				</label>
				<select
					id="filter-project"
					value={projectId || ''}
					onChange={(e) => onProjectIdChange(e.target.value || undefined)}
					className="block w-full pl-3 pr-10 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 20 20\'%3E%3Cpath stroke=\'%23a1a1aa\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'1.5\' d=\'m6 8 4 4 4-4\'/%3E%3C/svg%3E')] bg-[right_0.5rem_center] bg-[length:1.25rem_1.25rem] bg-no-repeat"
				>
					<option value="">All Projects</option>
					{projectsQuery.data?.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name} ({p.id})
						</option>
					))}
				</select>
			</div>

			<div className="w-[180px]">
				<label htmlFor="filter-status" className="block text-xs font-medium text-zinc-400 mb-1.5">
					Status
				</label>
				<select
					id="filter-status"
					value={status || ''}
					onChange={(e) => onStatusChange(e.target.value || undefined)}
					className="block w-full pl-3 pr-10 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 20 20\'%3E%3Cpath stroke=\'%23a1a1aa\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'1.5\' d=\'m6 8 4 4 4-4\'/%3E%3C/svg%3E')] bg-[right_0.5rem_center] bg-[length:1.25rem_1.25rem] bg-no-repeat"
				>
					<option value="">All Statuses</option>
					<option value="running">Running</option>
					<option value="completed">Completed</option>
					<option value="failed">Failed</option>
					<option value="deferred">Deferred</option>
				</select>
			</div>

			<div className="w-[200px]">
				<label htmlFor="filter-phase" className="block text-xs font-medium text-zinc-400 mb-1.5">
					Phase
				</label>
				<select
					id="filter-phase"
					value={phase || ''}
					onChange={(e) => onPhaseChange(e.target.value || undefined)}
					className="block w-full pl-3 pr-10 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 20 20\'%3E%3Cpath stroke=\'%23a1a1aa\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'1.5\' d=\'m6 8 4 4 4-4\'/%3E%3C/svg%3E')] bg-[right_0.5rem_center] bg-[length:1.25rem_1.25rem] bg-no-repeat"
				>
					<option value="">All Phases</option>
					<option value="planning">Planning</option>
					<option value="implementation">Implementation</option>
					<option value="review">Review</option>
					<option value="respond-to-review">Respond to Review</option>
					<option value="respond-to-ci">Respond to CI</option>
				</select>
			</div>

			{hasActiveFilters && (
				<button
					type="button"
					onClick={onClear}
					className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-900/50 border border-zinc-800 rounded hover:bg-zinc-800/60 transition-colors cursor-pointer h-[38px]"
				>
					<X className="h-3.5 w-3.5" />
					Clear Filters
				</button>
			)}
		</div>
	);
}
