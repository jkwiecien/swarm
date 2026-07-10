import { useQuery } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { AlertTriangle, ExternalLink, Info, Terminal } from 'lucide-react';
import { useState } from 'react';
import { LogViewer } from '@/components/runs/log-viewer.js';
import { RunStatusBadge } from '@/components/runs/run-status-badge.js';
import { trpc } from '@/lib/trpc.js';
import { rootRoute } from '../__root.js';

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

type RunStatus = 'running' | 'completed' | 'failed' | 'deferred';

interface RunDetailHeaderProps {
	run: RunRow;
}

function formatPhase(phase: string) {
	return phase.replace(/-/g, ' ');
}

function RunDetailHeader({ run }: RunDetailHeaderProps) {
	return (
		<div className="space-y-6">
			{/* Breadcrumb */}
			<div className="text-xs font-mono text-zinc-500">
				<Link to="/runs" className="hover:text-zinc-300 transition-colors">
					runs
				</Link>{' '}
				/ <span className="text-zinc-300 font-semibold select-all">{run.id}</span>
			</div>

			{/* Page Title */}
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-zinc-100 capitalize">
						{formatPhase(run.phase)} Run
					</h1>
					<p className="text-xs text-zinc-500 mt-1 font-mono">{run.id}</p>
				</div>
				<RunStatusBadge status={run.status as RunStatus} className="text-sm px-3 py-1" />
			</div>

			{/* Error Banner if run failed or deferred */}
			{run.error && (
				<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex items-start gap-3">
					<AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
					<div>
						<h3 className="text-xs font-semibold text-red-200">Run Failure Error</h3>
						<p className="text-xs text-red-400/80 mt-1 font-mono whitespace-pre-wrap">
							{run.error}
						</p>
					</div>
				</div>
			)}
		</div>
	);
}

interface RunOverviewProps {
	run: RunRow;
	project?: { name: string; repo: string } | null;
}

function RunOverview({ run, project }: RunOverviewProps) {
	const hasWorkItem = !!run.workItemId;
	const hasPR = !!run.prNumber;

	function formatDuration(ms: number | null): string {
		if (ms === null || ms === undefined) return '—';
		const sec = Math.round(ms / 1000);
		if (sec < 60) return `${sec}s`;
		const min = Math.floor(sec / 60);
		const remainingSec = sec % 60;
		return `${min}m ${remainingSec}s`;
	}

	return (
		<div className="border border-zinc-800 rounded-lg bg-[#0F0F11]/40 p-6 shadow-sm space-y-6">
			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Run Details
				</h2>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-8">
					<div>
						<span className="block text-xs font-medium text-zinc-400">Project</span>
						<span className="text-sm text-zinc-200 mt-1 block">
							{project?.name || run.projectId}{' '}
							<span className="text-xs text-zinc-500 font-mono">({run.projectId})</span>
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Task ID</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">{run.taskId}</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Phase</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono capitalize">
							{formatPhase(run.phase)}
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Status</span>
						<span className="mt-1 block">
							<RunStatusBadge status={run.status as RunStatus} />
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400 font-sans">
							GitHub References
						</span>
						<div className="text-sm text-zinc-200 mt-1 block">
							{!hasWorkItem && !hasPR ? (
								<span className="text-zinc-500 font-mono">—</span>
							) : (
								<div className="flex flex-col gap-1.5">
									{hasPR && (
										<a
											href={`https://github.com/${project?.repo}/pull/${run.prNumber}`}
											target="_blank"
											rel="noopener noreferrer"
											className="inline-flex items-center gap-1 text-violet-400 hover:text-violet-300 font-mono hover:underline w-fit"
										>
											PR #{run.prNumber}
											<ExternalLink className="h-3 w-3" />
										</a>
									)}
									{hasWorkItem && (
										<a
											href={`https://github.com/${project?.repo}/issues/${run.workItemId}`}
											target="_blank"
											rel="noopener noreferrer"
											className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-300 font-mono hover:underline w-fit"
										>
											Issue #{run.workItemId}
											<ExternalLink className="h-3 w-3" />
										</a>
									)}
								</div>
							)}
						</div>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Duration</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">
							{formatDuration(run.durationMs)}
						</span>
					</div>
				</div>
			</div>

			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Execution Environment
				</h2>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-8">
					<div>
						<span className="block text-xs font-medium text-zinc-400">Engine / CLI</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">{run.engine || '—'}</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Model Used</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">{run.model || '—'}</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Exit Code</span>
						<span
							className={`text-sm mt-1 block font-mono ${
								run.exitCode !== 0 && run.exitCode !== null
									? 'text-red-400 font-bold'
									: 'text-zinc-200'
							}`}
						>
							{run.exitCode !== null ? run.exitCode : '—'}
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Timed Out</span>
						<span
							className={`text-sm mt-1 block ${
								run.timedOut ? 'text-red-400 font-semibold' : 'text-zinc-400'
							}`}
						>
							{run.timedOut ? 'Yes' : 'No'}
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Started At</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono text-xs">
							{new Date(run.startedAt).toLocaleString()}
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Completed At</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono text-xs">
							{run.completedAt ? new Date(run.completedAt).toLocaleString() : '—'}
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}

function RunDetailRouteComponent() {
	const { runId } = runDetailRoute.useParams();
	const [activeTab, setActiveTab] = useState<'overview' | 'logs'>('overview');

	// Query project list to map projectId to project repo/name
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectsMap = new Map(projectsQuery.data?.map((p) => [p.id, p]) ?? []);

	// Fetch run details and poll if running
	const runQuery = useQuery({
		...trpc.runs.getById.queryOptions({ id: runId }),
		refetchInterval: (query) => {
			const run = query.state.data;
			return run && run.status === 'running' ? 2000 : false;
		},
	});

	// Fetch run logs and poll if running
	const logsQuery = useQuery({
		...trpc.runs.getLogs.queryOptions({ runId }),
		refetchInterval: () => {
			return runQuery.data && runQuery.data.status === 'running' ? 2000 : false;
		},
	});

	if (runQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading run details…</div>;
	}

	if (runQuery.isError) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded flex items-center gap-2">
				<AlertTriangle className="h-4 w-4 shrink-0" />
				<span>{runQuery.error.message}</span>
			</div>
		);
	}

	const run = runQuery.data;
	if (!run) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				Run not found.
			</div>
		);
	}

	const project = projectsMap.get(run.projectId);

	return (
		<div className="space-y-6">
			<RunDetailHeader run={run as unknown as RunRow} />

			{/* Tab Bar */}
			<div className="flex border-b border-zinc-800">
				<button
					type="button"
					onClick={() => setActiveTab('overview')}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all cursor-pointer ${
						activeTab === 'overview'
							? 'border-b-2 border-violet-500 text-white bg-zinc-800/20'
							: 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<Info className="h-4 w-4" />
					Overview
				</button>
				<button
					type="button"
					onClick={() => setActiveTab('logs')}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all cursor-pointer ${
						activeTab === 'logs'
							? 'border-b-2 border-violet-500 text-white bg-zinc-800/20'
							: 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<Terminal className="h-4 w-4" />
					Logs
				</button>
			</div>

			{/* Active Tab Content */}
			{activeTab === 'overview' ? (
				<RunOverview run={run as unknown as RunRow} project={project} />
			) : (
				<LogViewer
					stdout={logsQuery.data?.stdout ?? null}
					stderr={logsQuery.data?.stderr ?? null}
				/>
			)}
		</div>
	);
}

export const runDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/runs/$runId',
	component: RunDetailRouteComponent,
});
