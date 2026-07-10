import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { trpc } from '@/lib/trpc.js';
import { RunStatusBadge } from './run-status-badge.js';

interface RunRow {
	id: string;
	projectId: string;
	taskId: string;
	workItemId: string | null;
	prNumber: string | null;
	phase: string;
	engine: string | null;
	model: string | null;
	status: string;
	exitCode: number | null;
	timedOut: boolean;
	error: string | null;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
}

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

	const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
	const startIdx = (currentPage - 1) * pageSize + 1;
	const endIdx = Math.min(currentPage * pageSize, totalCount);

	function formatDuration(ms: number | null): string {
		if (ms === null || ms === undefined) return '—';
		const sec = Math.round(ms / 1000);
		if (sec < 60) return `${sec}s`;
		const min = Math.floor(sec / 60);
		const remainingSec = sec % 60;
		return `${min}m ${remainingSec}s`;
	}

	function formatRelativeTime(dateString: string): string {
		const date = new Date(dateString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffSec = Math.floor(diffMs / 1000);
		if (diffSec < 60) return 'Just now';
		const diffMin = Math.floor(diffSec / 60);
		if (diffMin < 60) return `${diffMin}m ago`;
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) return `${diffHr}h ago`;
		return (
			date.toLocaleDateString() +
			' ' +
			date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		);
	}

	const handleRowClick = (runId: string) => {
		navigate({ to: `/runs/${runId}` });
	};

	const renderWorkItemCell = (run: RunRow) => {
		const project = projectsMap.get(run.projectId);
		const hasWorkItem = !!run.workItemId;
		const hasPR = !!run.prNumber;

		if (!project || (!hasWorkItem && !hasPR)) {
			return <span className="text-zinc-500 font-mono">—</span>;
		}

		const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

		return (
			<div className="flex flex-col gap-1 text-xs">
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
				{hasWorkItem && (
					<a
						href={`https://github.com/${project.repo}/issues/${run.workItemId}`}
						target="_blank"
						rel="noopener noreferrer"
						onClick={stopPropagation}
						className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-300 font-mono hover:underline"
					>
						Issue #{run.workItemId}
						<ExternalLink className="h-3 w-3" />
					</a>
				)}
			</div>
		);
	};

	const formatPhase = (phase: string) => {
		return phase.replace(/-/g, ' ');
	};

	return (
		<div className="space-y-4">
			<div className="border border-zinc-800 rounded-md overflow-hidden bg-[#0F0F11]/20 shadow-sm">
				<table className="w-full text-left border-collapse">
					<thead>
						<tr className="bg-zinc-800/30 border-b border-zinc-800">
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Phase
							</th>
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Project
							</th>
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Task / ID
							</th>
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Status
							</th>
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Started
							</th>
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Duration
							</th>
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Model
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800/60">
						{runs.length === 0 ? (
							<tr>
								<td colSpan={7} className="px-4 py-8 text-center text-sm text-zinc-500">
									No runs found matching the selected filters.
								</td>
							</tr>
						) : (
							runs.map((run) => (
								<tr
									key={run.id}
									onClick={() => handleRowClick(run.id)}
									className="hover:bg-zinc-800/40 transition-colors cursor-pointer"
								>
									<td className="px-4 py-3 text-sm font-semibold text-zinc-100 capitalize">
										{formatPhase(run.phase)}
									</td>
									<td className="px-4 py-3 text-sm text-zinc-300 font-mono">
										{projectsMap.get(run.projectId)?.name || run.projectId}
									</td>
									<td className="px-4 py-3 text-sm">
										<div className="flex flex-col gap-1">
											<span
												className="font-mono text-zinc-300 text-xs truncate max-w-[150px]"
												title={run.taskId}
											>
												{run.taskId}
											</span>
											{renderWorkItemCell(run)}
										</div>
									</td>
									<td className="px-4 py-3 text-sm">
										<RunStatusBadge
											status={run.status as 'running' | 'completed' | 'failed' | 'deferred'}
										/>
									</td>
									<td className="px-4 py-3 text-sm text-zinc-400">
										{formatRelativeTime(run.startedAt)}
									</td>
									<td className="px-4 py-3 text-sm text-zinc-400 font-mono">
										{formatDuration(run.durationMs)}
									</td>
									<td className="px-4 py-3 text-sm text-zinc-400 font-mono text-xs">
										{run.model || '—'}
									</td>
								</tr>
							))
						)}
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
