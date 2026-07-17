import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import {
	formatDuration,
	formatPhase,
	formatRelativeTime,
	formatTokensCompact,
} from '@/lib/format.js';
import { resolveRunDurationMs, useNow } from '@/lib/run-duration.js';
import { runTableColumnWidths } from '@/lib/run-table-layout.js';
import { trpc } from '@/lib/trpc.js';
import { parseWorkItemRef, workItemLabel } from '@/lib/work-item.js';
import type { RunRow } from '@/types/runs.js';
import { RunStatusBadge } from './run-status-badge.js';

interface RunsTableProps {
	runs: RunRow[];
	totalCount: number;
	currentPage: number;
	pageSize: number;
	onPageChange: (page: number) => void;
	/**
	 * Whether to render the Project column. `true` for the global `/runs` view;
	 * `false` for the project-scoped Runs tab, where every row is the same project
	 * and the freed width goes to the Task / ID column (issue #168).
	 */
	showProject?: boolean;
}

const PR_DRIVEN_PHASES = new Set([
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
]);

function WorkItemCell({ run, repo }: { run: RunRow; repo?: string }) {
	const hasWorkItem = !!run.workItemId;
	const hasPR = !!run.prNumber;
	const workItemRef = parseWorkItemRef(run.workItemUrl);
	const isPrDriven = PR_DRIVEN_PHASES.has(run.phase);
	const title = isPrDriven ? run.prTitle : run.workItemTitle;

	if (!repo || (!hasWorkItem && !hasPR)) {
		return <span className="text-zinc-500 font-mono">—</span>;
	}

	const stopPropagation = (event: React.MouseEvent) => event.stopPropagation();

	return (
		<div className="flex w-full min-w-0 flex-col gap-1 text-xs">
			{title && (
				<span className="block w-full truncate text-zinc-200" title={title}>
					{title}
				</span>
			)}
			{isPrDriven && hasPR ? (
				<a
					href={`https://github.com/${repo}/pull/${run.prNumber}`}
					target="_blank"
					rel="noopener noreferrer"
					onClick={stopPropagation}
					className="inline-flex self-start items-center gap-1 text-violet-400 hover:text-violet-300 font-mono hover:underline"
				>
					PR #{run.prNumber}
					<ExternalLink className="h-3 w-3" />
				</a>
			) : hasWorkItem && workItemRef ? (
				<a
					href={run.workItemUrl ?? undefined}
					target="_blank"
					rel="noopener noreferrer"
					onClick={stopPropagation}
					className="inline-flex self-start items-center gap-1 text-zinc-400 hover:text-zinc-300 font-mono hover:underline"
				>
					{workItemLabel(workItemRef)}
					<ExternalLink className="h-3 w-3" />
				</a>
			) : hasWorkItem ? (
				<span className="text-zinc-400 font-mono">Issue: #{run.taskId}</span>
			) : null}
		</div>
	);
}

export function RunsTable({
	runs,
	totalCount,
	currentPage,
	pageSize,
	onPageChange,
	showProject = true,
}: RunsTableProps) {
	const navigate = useNavigate();
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectsMap = new Map(projectsQuery.data?.map((p) => [p.id, p]) ?? []);
	const columnWidths = runTableColumnWidths(showProject);
	const now = useNow(runs.some((run) => run.status === 'running'));

	const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
	const startIdx = (currentPage - 1) * pageSize + 1;
	const endIdx = Math.min(currentPage * pageSize, totalCount);

	const handleRowClick = (runId: string) => {
		navigate({ to: `/runs/${runId}` });
	};

	return (
		<div className="space-y-4">
			<div className="border border-zinc-800 rounded-md overflow-hidden bg-[#0F0F11]/20 shadow-sm">
				<table className="w-full table-fixed text-left border-collapse">
					<colgroup>
						<col className={columnWidths.phase} />
						{showProject && <col className={columnWidths.project} />}
						<col className={columnWidths.task} />
						<col className={columnWidths.status} />
						<col className={columnWidths.started} />
						<col className={columnWidths.duration} />
						<col className={columnWidths.model} />
						<col className={columnWidths.tokens} />
					</colgroup>
					<thead>
						<tr className="bg-zinc-800/30 border-b border-zinc-800">
							<th className="px-2 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Phase
							</th>
							{showProject && (
								<th className="px-2 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
									Project
								</th>
							)}
							<th
								className={`${columnWidths.task} px-2 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400`}
							>
								Task / ID
							</th>
							<th className="px-2 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Status
							</th>
							<th className="px-2 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Started
							</th>
							<th className="px-2 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Duration
							</th>
							<th className="px-2 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Model
							</th>
							<th className="px-2 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Tokens
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800/60">
						{runs.map((run) => (
							<tr
								key={run.id}
								onClick={() => handleRowClick(run.id)}
								className="hover:bg-zinc-800/40 transition-colors cursor-pointer"
							>
								<td className="px-2 py-3 text-sm font-semibold text-zinc-100 capitalize">
									{formatPhase(run.phase)}
								</td>
								{showProject && (
									<td className="px-2 py-3 text-sm text-zinc-300 font-mono">
										{projectsMap.get(run.projectId)?.name || run.projectId}
									</td>
								)}
								<td className={`${columnWidths.task} px-2 py-3 text-sm`}>
									<WorkItemCell run={run} repo={projectsMap.get(run.projectId)?.repo} />
								</td>
								<td className="px-2 py-3 text-sm">
									<RunStatusBadge
										status={run.status as 'running' | 'completed' | 'failed' | 'deferred'}
										timedOut={run.timedOut}
										phase={run.phase}
										reviewVerdict={run.reviewVerdict}
									/>
								</td>
								<td className="px-2 py-3 text-sm text-zinc-400">
									{formatRelativeTime(run.startedAt)}
								</td>
								<td className="px-2 py-3 text-sm text-zinc-400 font-mono">
									{formatDuration(resolveRunDurationMs(run, now))}
								</td>
								<td className="px-2 py-3 text-sm text-zinc-400 font-mono text-xs">
									{run.model || '—'}
									{run.reasoning ? <span className="text-zinc-500"> · {run.reasoning}</span> : null}
								</td>
								<td
									className="px-2 py-3 text-sm text-zinc-400 font-mono text-xs"
									title="input / output tokens"
								>
									{formatTokensCompact(run.usage)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{totalCount > 0 && (
				<div className="flex items-center justify-between text-xs text-zinc-400 py-2">
					<div>
						Showing <span className="font-semibold text-zinc-200">{startIdx}</span> to{' '}
						<span className="font-semibold text-zinc-200">{endIdx}</span> of{' '}
						<span className="font-semibold text-zinc-200">{totalCount}</span> runs
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => onPageChange(currentPage - 1)}
							disabled={currentPage === 1}
							className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
						>
							Previous
						</button>
						<span className="px-2">
							Page {currentPage} of {totalPages}
						</span>
						<button
							type="button"
							onClick={() => onPageChange(currentPage + 1)}
							disabled={currentPage === totalPages}
							className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
						>
							Next
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
