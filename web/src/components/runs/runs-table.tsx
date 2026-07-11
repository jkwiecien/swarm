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
}

export function RunsTable({
	runs,
	totalCount,
	currentPage,
	pageSize,
	onPageChange,
}: RunsTableProps) {
	const navigate = useNavigate();
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectsMap = new Map(projectsQuery.data?.map((p) => [p.id, p]) ?? []);
	const now = useNow(runs.some((run) => run.status === 'running'));

	const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
	const startIdx = (currentPage - 1) * pageSize + 1;
	const endIdx = Math.min(currentPage * pageSize, totalCount);

	const handleRowClick = (runId: string) => {
		navigate({ to: `/runs/${runId}` });
	};

	const renderWorkItemCell = (run: RunRow) => {
		const project = projectsMap.get(run.projectId);
		const hasWorkItem = !!run.workItemId;
		const hasPR = !!run.prNumber;
		const workItemRef = parseWorkItemRef(run.workItemUrl);

		if (!project || (!hasWorkItem && !hasPR)) {
			return <span className="text-zinc-500 font-mono">—</span>;
		}

		const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

		return (
			<div className="flex w-full min-w-0 flex-col gap-1 text-xs">
				{hasPR && (
					<a
						href={`https://github.com/${project.repo}/pull/${run.prNumber}`}
						target="_blank"
						rel="noopener noreferrer"
						onClick={stopPropagation}
						className="inline-flex items-center gap-1 text-violet-400 hover:text-violet-300 font-mono hover:underline"
					>
						PR #{run.prNumber}
						<ExternalLink className="h-3 w-3" />
					</a>
				)}
				{hasWorkItem && run.workItemTitle && workItemRef ? (
					<>
						<span className="block w-full truncate text-zinc-300" title={run.workItemTitle}>
							{run.workItemTitle}
						</span>
						<a
							href={run.workItemUrl ?? undefined}
							target="_blank"
							rel="noopener noreferrer"
							onClick={stopPropagation}
							className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-300 font-mono hover:underline"
						>
							{workItemLabel(workItemRef)}
							<ExternalLink className="h-3 w-3" />
						</a>
					</>
				) : hasWorkItem ? (
					<span className="text-zinc-400 font-mono">Issue: #{run.taskId}</span>
				) : null}
			</div>
		);
	};

	return (
		<div className="space-y-4">
			<div className="border border-zinc-800 rounded-md overflow-hidden bg-[#0F0F11]/20 shadow-sm">
				<table className="w-full text-left border-collapse">
					<thead>
						<tr className="bg-zinc-800/30 border-b border-zinc-800">
							<th className="px-2 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Phase
							</th>
							<th className="px-2 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Project
							</th>
							<th className="w-[30%] px-2 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
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
								<td className="px-2 py-3 text-sm text-zinc-300 font-mono">
									{projectsMap.get(run.projectId)?.name || run.projectId}
								</td>
								<td className="w-[30%] px-2 py-3 text-sm">
									<div className="flex w-full min-w-0 flex-col gap-1">
										{run.prTitle ? (
											// PR-driven phases (review / respond-to-*): show the human-readable
											// PR title rather than the synthetic `<pr>-respond` taskId.
											<span
												className="block w-full truncate text-xs text-zinc-200"
												title={run.prTitle}
											>
												{run.prTitle}
											</span>
										) : (
											<span
												className="block w-full truncate font-mono text-xs text-zinc-300"
												title={run.taskId}
											>
												{run.taskId}
											</span>
										)}
										{renderWorkItemCell(run)}
									</div>
								</td>
								<td className="px-2 py-3 text-sm">
									<RunStatusBadge
										status={run.status as 'running' | 'completed' | 'failed' | 'deferred'}
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
