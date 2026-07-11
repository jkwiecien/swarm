import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { AlertTriangle, ExternalLink, Info, RefreshCw, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { LogViewer } from '@/components/runs/log-viewer.js';
import { RunStatusBadge } from '@/components/runs/run-status-badge.js';
import { formatDuration, formatPhase, formatTimeUntil, formatTokenCount } from '@/lib/format.js';
import { resolveRunDurationMs, useNow } from '@/lib/run-duration.js';
import { canRetryRun, retryButtonLabel } from '@/lib/run-retry.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { parseWorkItemRef, workItemLabel } from '@/lib/work-item.js';
import type { AgentUsage, RunRow } from '@/types/runs.js';
import { rootRoute } from '../__root.js';

type RunStatus = 'running' | 'completed' | 'failed' | 'deferred';

/**
 * "Retry now" for a deferred run (issue #136): promotes the run's pending
 * scheduled retry so it fires immediately instead of after its delay. Follows
 * the mutation→invalidate pattern in project-create-dialog.tsx — on success it
 * invalidates this run's `getById` and the runs `list` so the status flip to
 * `running` shows without a manual refresh (the detail page also polls while
 * deferred/running). Disabled + "Retrying…" while pending; an actionable banner
 * surfaces a rejected mutation (e.g. the run already left `deferred`).
 */
function RetryNowButton({ runId }: { runId: string }) {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: () => trpcClient.runs.retryNow.mutate({ runId }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: trpc.runs.getById.queryKey({ id: runId }) });
			queryClient.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
		},
	});

	return (
		<div className="mt-3">
			<button
				type="button"
				onClick={() => mutation.mutate()}
				disabled={mutation.isPending}
				className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-50 disabled:cursor-not-allowed"
			>
				<RefreshCw className={`h-4 w-4 ${mutation.isPending ? 'animate-spin' : ''}`} />
				{retryButtonLabel(mutation.isPending)}
			</button>
			{mutation.isError && (
				<div className="mt-2 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{mutation.error.message}
				</div>
			)}
		</div>
	);
}

interface RunDetailHeaderProps {
	run: RunRow;
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

			{run.status === 'deferred' && run.nextRetryAt && (
				<div className="p-4 bg-amber-950/20 border border-amber-900/30 rounded flex items-start gap-3">
					<AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
					<div>
						<h3 className="text-xs font-semibold text-amber-200">
							Deferred — automatic retry scheduled
						</h3>
						{run.error && (
							<p className="text-xs text-amber-200/70 mt-1 font-mono whitespace-pre-wrap">
								{run.error}
							</p>
						)}
						<p className="text-xs text-amber-200/70 mt-2 font-mono">
							{new Date(run.nextRetryAt).toLocaleString()} ({formatTimeUntil(run.nextRetryAt)})
						</p>
						<p className="text-xs text-amber-200/70 mt-1 font-mono">
							UTC: {new Date(run.nextRetryAt).toISOString()}
						</p>
						{canRetryRun(run.status) && <RetryNowButton runId={run.id} />}
					</div>
				</div>
			)}

			{run.status === 'failed' && run.error && (
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

interface GitHubReferencesProps {
	run: RunRow;
	project?: { name: string; repo: string } | null;
}

function GitHubReferences({ run, project }: GitHubReferencesProps) {
	const hasWorkItem = !!run.workItemId;
	const hasPR = !!run.prNumber;
	const workItemRef = parseWorkItemRef(run.workItemUrl);

	if (!hasWorkItem && !hasPR) {
		return <span className="text-zinc-500 font-mono">—</span>;
	}

	return (
		<div className="flex flex-col gap-1.5">
			{hasPR &&
				(project?.repo ? (
					<a
						href={`https://github.com/${project.repo}/pull/${run.prNumber}`}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-violet-400 hover:text-violet-300 font-mono hover:underline w-fit"
					>
						PR #{run.prNumber}
						<ExternalLink className="h-3 w-3" />
					</a>
				) : (
					<span className="text-zinc-400 font-mono">PR #{run.prNumber}</span>
				))}
			{hasWorkItem && run.workItemTitle && workItemRef ? (
				<>
					<span className="text-zinc-300" title={run.workItemTitle}>
						{run.workItemTitle}
					</span>
					<a
						href={run.workItemUrl ?? undefined}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-300 font-mono hover:underline w-fit"
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
}

interface TokenUsageFieldProps {
	label: string;
	value: number;
}

function TokenUsageField({ label, value }: TokenUsageFieldProps) {
	return (
		<div>
			<span className="block text-xs font-medium text-zinc-400">{label}</span>
			<span className="text-sm text-zinc-200 mt-1 block font-mono">
				{value.toLocaleString()}{' '}
				<span className="text-xs text-zinc-500">({formatTokenCount(value)})</span>
			</span>
		</div>
	);
}

interface TokenUsageSectionProps {
	usage: AgentUsage | null;
}

function TokenUsageSection({ usage }: TokenUsageSectionProps) {
	return (
		<div>
			<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
				Token Usage
			</h2>
			{usage ? (
				<div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-8">
					<TokenUsageField label="Input" value={usage.inputTokens} />
					<TokenUsageField label="Output" value={usage.outputTokens} />
					{usage.cacheReadTokens !== undefined && (
						<TokenUsageField label="Cache read" value={usage.cacheReadTokens} />
					)}
					{usage.cacheCreationTokens !== undefined && (
						<TokenUsageField label="Cache creation" value={usage.cacheCreationTokens} />
					)}
					{usage.reasoningTokens !== undefined && (
						<TokenUsageField label="Reasoning" value={usage.reasoningTokens} />
					)}
					{usage.totalTokens !== undefined && (
						<TokenUsageField label="Total" value={usage.totalTokens} />
					)}
				</div>
			) : (
				<p className="text-sm text-zinc-500">Not reported by this run's CLI.</p>
			)}
		</div>
	);
}

interface RunOverviewProps {
	run: RunRow;
	project?: { name: string; repo: string } | null;
}

function RunOverview({ run, project }: RunOverviewProps) {
	const now = useNow(run.status === 'running');

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
							<GitHubReferences run={run} project={project} />
						</div>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Duration</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">
							{formatDuration(resolveRunDurationMs(run, now))}
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

					{run.nextRetryAt && (
						<div>
							<span className="block text-xs font-medium text-zinc-400">Next Retry</span>
							<span className="text-sm text-zinc-200 mt-1 block font-mono text-xs">
								{new Date(run.nextRetryAt).toLocaleString()} ({formatTimeUntil(run.nextRetryAt)})
							</span>
							<span className="text-xs text-zinc-500 mt-1 block font-mono">
								{new Date(run.nextRetryAt).toISOString()}
							</span>
						</div>
					)}
				</div>
			</div>

			<TokenUsageSection usage={run.usage} />
		</div>
	);
}

function RunDetailRouteComponent() {
	const { runId } = runDetailRoute.useParams();
	const [activeTab, setActiveTab] = useState<'overview' | 'logs'>('overview');

	// Query project list to map projectId to project repo/name
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectsMap = new Map(projectsQuery.data?.map((p) => [p.id, p]) ?? []);

	// Fetch run details and poll while the run can still change automatically.
	const runQuery = useQuery({
		...trpc.runs.getById.queryOptions({ id: runId }),
		refetchInterval: (query) => {
			const run = query.state.data;
			return run && (run.status === 'running' || run.status === 'deferred') ? 2000 : false;
		},
	});

	// Fetch run logs and poll while the run can still change automatically.
	const logsQuery = useQuery({
		...trpc.runs.getLogs.queryOptions({ runId }),
		refetchInterval: () => {
			return runQuery.data &&
				(runQuery.data.status === 'running' || runQuery.data.status === 'deferred')
				? 2000
				: false;
		},
	});

	// Trigger a final logs refetch when status transitions out of 'running'
	const status = runQuery.data?.status;
	const prevStatusRef = useRef<string | undefined>(status);
	useEffect(() => {
		if (prevStatusRef.current === 'running' && status && status !== 'running') {
			logsQuery.refetch();
		}
		prevStatusRef.current = status;
	}, [status, logsQuery]);

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
