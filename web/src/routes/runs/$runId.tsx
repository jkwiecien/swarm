import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import {
	AlertTriangle,
	ChevronDown,
	ExternalLink,
	Info,
	Loader2,
	OctagonX,
	Play,
	RefreshCw,
	Terminal,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type LiveOutputEvent, LiveOutputViewer } from '@/components/runs/live-output-viewer.js';
import { LogViewer } from '@/components/runs/log-viewer.js';
import { RunStatusBadge } from '@/components/runs/run-status-badge.js';
import { Modal, ModalFooter } from '@/components/ui/modal.js';
import { formatDuration, formatPhase, formatTimeUntil, formatTokenCount } from '@/lib/format.js';
import { resolveRunDurationMs, useNow } from '@/lib/run-duration.js';
import {
	canRetryRun,
	type RetryActionKind,
	retryActionKind,
	retryButtonLabel,
} from '@/lib/run-retry.js';
import {
	canTerminateRun,
	terminateButtonLabel,
	terminateConfirmMessage,
} from '@/lib/run-terminate.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { parseWorkItemRef, workItemLabel } from '@/lib/work-item.js';
import type { AgentUsage, RunRow } from '@/types/runs.js';
// Shared model catalog — the single source of truth (`src/harness/models.ts`), so
// the retry override dropdowns stay in lockstep with the config UI (issue #180).
import type { AgentCli } from '../../../../src/harness/agent-cli.js';
import {
	capabilityFor,
	MODEL_CAPABILITIES,
	normalizeModelSelection,
	type ReasoningLevel,
	reasoningChoicesFor,
} from '../../../../src/harness/models.js';
import { rootRoute } from '../__root.js';

type RunStatus = 'running' | 'completed' | 'failed' | 'deferred';

const RUN_AGENTS = ['claude', 'antigravity', 'codex'] as const;
type RunAgent = AgentCli;

/** Capitalize a normalized reasoning level for display ("high" → "High"). */
function capitalizeLevel(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The split button's color treatment (issue #227): emerald for a session
 * "Resume", violet for a fresh "Retry now". Shared by the wrapper (shadow), the
 * main button, and the chevron so the whole control reads as one green/violet
 * piece.
 */
function retrySplitPalette(isResume: boolean): { wrapper: string; main: string; chevron: string } {
	return isResume
		? {
				wrapper: 'shadow-emerald-950/10',
				main: 'bg-emerald-600 hover:bg-emerald-500 focus:ring-emerald-500 border-emerald-700/50',
				chevron: 'bg-emerald-600 hover:bg-emerald-500 focus:ring-emerald-500',
			}
		: {
				wrapper: 'shadow-violet-950/10',
				main: 'bg-violet-600 hover:bg-violet-500 focus:ring-violet-500 border-violet-700/50',
				chevron: 'bg-violet-600 hover:bg-violet-500 focus:ring-violet-500',
			};
}

/**
 * The main-action + chevron pair of the retry control. A resumable deferred run
 * shows a green "Resume" (Play glyph); every other retryable run shows the violet
 * "Retry now" (RefreshCw). The chevron opens the override popup the parent owns.
 */
function RetrySplitButton({
	kind,
	palette,
	isPending,
	onPrimary,
	onToggle,
}: {
	kind: RetryActionKind;
	palette: { main: string; chevron: string };
	isPending: boolean;
	onPrimary: () => void;
	onToggle: () => void;
}) {
	const isResume = kind === 'resume';
	return (
		<>
			{/* Main Button — resume or fresh retry, per the run's server semantics. */}
			<button
				type="button"
				onClick={onPrimary}
				disabled={isPending}
				className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white rounded-l-md focus:outline-none focus:ring-1 focus:ring-offset-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed border-r cursor-pointer ${palette.main}`}
			>
				{isResume ? (
					<Play className={`h-4 w-4 ${isPending ? 'animate-pulse' : ''}`} />
				) : (
					<RefreshCw className={`h-4 w-4 ${isPending ? 'animate-spin' : ''}`} />
				)}
				{retryButtonLabel(kind, isPending)}
			</button>

			{/* Chevron button (the separate right part) */}
			<button
				type="button"
				onClick={onToggle}
				disabled={isPending}
				className={`inline-flex items-center px-2 py-2 text-sm font-semibold text-white rounded-r-md focus:outline-none focus:ring-1 focus:ring-offset-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${palette.chevron}`}
				title={
					isResume
						? 'Retry with a different model/agent (starts fresh, not a resume)'
						: 'Retry with different model/agent'
				}
			>
				<ChevronDown className="h-4 w-4" />
			</button>
		</>
	);
}

/**
 * Split retry button (issue #153): clicking the main left button retries the run
 * with its existing/preselected settings; clicking the chevron right button opens
 * a popup allowing overrides for the agent CLI and model.
 *
 * The main button's identity tracks the server's retry semantics (issue #227): a
 * `deferred` run that still holds a captured agent session resumes it — a green
 * "Resume" firing the retry path with no overrides (which promotes the pending
 * session-resume job) — while a non-resumable deferred run and a terminally
 * failed run relaunch from scratch as the original violet "Retry now". The
 * override popup is always a fresh retry, so choosing a different CLI/model never
 * masquerades as a resume.
 */
function RetryNowButton({ run }: { run: RunRow }) {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: (overrides: { cli?: RunAgent; model?: string; reasoning?: ReasoningLevel }) =>
			trpcClient.runs.retryNow.mutate({
				runId: run.id,
				cli: overrides.cli,
				model: overrides.model,
				reasoning: overrides.reasoning,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: trpc.runs.getById.queryKey({ id: run.id }) });
			queryClient.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
		},
	});

	const currentCli = (
		run.engine && (RUN_AGENTS as readonly string[]).includes(run.engine)
			? (run.engine as RunAgent)
			: 'claude'
	) as RunAgent;

	// A prior run's model may be a legacy combined antigravity string; decompose it
	// into the logical id (+ reasoning) the dropdowns now speak (issue #180).
	const normalizedCurrent = run.model ? normalizeModelSelection(currentCli, run.model) : undefined;
	const modelIds = MODEL_CAPABILITIES[currentCli].map((m) => m.id);
	const currentModel =
		normalizedCurrent?.model && modelIds.includes(normalizedCurrent.model)
			? normalizedCurrent.model
			: modelIds[0];
	const currentReasoning = (run.reasoning ?? normalizedCurrent?.reasoning) as
		| ReasoningLevel
		| undefined;

	const [isOpen, setIsOpen] = useState(false);
	const [selectedCli, setSelectedCli] = useState<RunAgent>(currentCli);
	const [selectedModel, setSelectedModel] = useState<string>(currentModel);
	const [selectedReasoning, setSelectedReasoning] = useState<ReasoningLevel | ''>(
		currentReasoning ?? '',
	);

	useEffect(() => {
		setSelectedCli(currentCli);
		setSelectedModel(currentModel);
		setSelectedReasoning(currentReasoning ?? '');
	}, [currentCli, currentModel, currentReasoning]);

	const reasoningOptions = reasoningChoicesFor(selectedCli, selectedModel);

	// A resumable deferred run continues its captured CLI session (green
	// "Resume"); everything else relaunches from scratch (violet "Retry now").
	const kind = retryActionKind(run.status, run.agentSessionId);
	const isResume = kind === 'resume';
	const palette = retrySplitPalette(isResume);

	return (
		<div className="mt-3">
			<div className={`relative inline-flex items-stretch rounded-md shadow-lg ${palette.wrapper}`}>
				<RetrySplitButton
					kind={kind}
					palette={palette}
					isPending={mutation.isPending}
					onPrimary={() => mutation.mutate({})}
					onToggle={() => setIsOpen(!isOpen)}
				/>

				{/* Popup */}
				{isOpen && (
					<>
						{/* Click-outside backdrop */}
						<button
							type="button"
							className="fixed inset-0 z-40 cursor-default focus:outline-none"
							onClick={() => setIsOpen(false)}
							aria-label="Close options"
						/>

						{/* The actual popover */}
						<div className="absolute left-0 top-full mt-2 z-50 w-72 bg-zinc-900 border border-zinc-850 rounded-lg shadow-2xl p-4 animate-in fade-in slide-in-from-top-2 duration-150">
							<div className="mb-3">
								<h4 className="text-xs font-semibold text-zinc-300 tracking-wide uppercase">
									Retry Options
								</h4>
								{isResume && (
									<p className="mt-1.5 text-[11px] font-normal normal-case tracking-normal leading-snug text-zinc-500">
										Choosing a different CLI or model starts a fresh retry instead of resuming this
										run's session.
									</p>
								)}
							</div>

							<div className="space-y-3 text-left">
								<div>
									<label
										htmlFor="agent-cli-select"
										className="block text-xs font-medium text-zinc-400 mb-1 select-none"
									>
										Agent CLI
									</label>
									<select
										id="agent-cli-select"
										value={selectedCli}
										onChange={(e) => {
											const newCli = e.target.value as RunAgent;
											setSelectedCli(newCli);
											setSelectedModel(MODEL_CAPABILITIES[newCli][0].id);
											// Reasoning is model-specific — clear it on any CLI change.
											setSelectedReasoning('');
										}}
										className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
									>
										{RUN_AGENTS.map((cli) => (
											<option key={cli} value={cli}>
												{cli}
											</option>
										))}
									</select>
								</div>

								<div>
									<label
										htmlFor="model-select"
										className="block text-xs font-medium text-zinc-400 mb-1 select-none"
									>
										Model
									</label>
									<select
										id="model-select"
										value={selectedModel}
										onChange={(e) => {
											const newModel = e.target.value;
											setSelectedModel(newModel);
											// Drop the reasoning if the new model doesn't support it.
											const stillValid =
												selectedReasoning &&
												(reasoningChoicesFor(selectedCli, newModel) as readonly string[]).includes(
													selectedReasoning,
												);
											if (!stillValid) setSelectedReasoning('');
										}}
										className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
									>
										{MODEL_CAPABILITIES[selectedCli].map((m) => (
											<option key={m.id} value={m.id}>
												{m.label}
											</option>
										))}
									</select>
								</div>

								<div>
									<label
										htmlFor="reasoning-select"
										className="block text-xs font-medium text-zinc-400 mb-1 select-none"
									>
										Reasoning
									</label>
									<select
										id="reasoning-select"
										value={selectedReasoning}
										onChange={(e) => setSelectedReasoning(e.target.value as ReasoningLevel | '')}
										disabled={reasoningOptions.length === 0}
										className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50 disabled:text-zinc-500"
									>
										<option value="">
											{reasoningOptions.length === 0
												? capabilityFor(selectedCli, selectedModel)?.fixedVariant
													? 'Fixed'
													: 'N/A'
												: (() => {
														const def = capabilityFor(selectedCli, selectedModel)?.defaultReasoning;
														return def ? `Default (${capitalizeLevel(def)})` : 'Default';
													})()}
										</option>
										{reasoningOptions.map((level) => (
											<option key={level} value={level}>
												{capitalizeLevel(level)}
											</option>
										))}
									</select>
								</div>

								<div className="pt-2 flex justify-end gap-2">
									<button
										type="button"
										onClick={() => setIsOpen(false)}
										className="px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
									>
										Cancel
									</button>
									<button
										type="button"
										onClick={() => {
											mutation.mutate({
												cli: selectedCli,
												model: selectedModel,
												reasoning: selectedReasoning || undefined,
											});
											setIsOpen(false);
										}}
										className="px-3 py-1.5 text-xs font-semibold text-white bg-violet-600 rounded hover:bg-violet-500 transition-colors cursor-pointer"
									>
										Retry Now
									</button>
								</div>
							</div>
						</div>
					</>
				)}
			</div>
			{mutation.isError && (
				<div className="mt-2 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{mutation.error.message}
				</div>
			)}
		</div>
	);
}

/**
 * "Terminate" action (issue #166) for a running or deferred run: a click opens a
 * confirmation modal (an intentional stop that can't be undone), and confirming
 * fires the `runs.terminate` mutation. The button carries its own pending state
 * so a double-click can't fire twice; the mutation is idempotent server-side.
 */
function TerminateRunButton({ run }: { run: RunRow }) {
	const queryClient = useQueryClient();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const mutation = useMutation({
		mutationFn: () => trpcClient.runs.terminate.mutate({ runId: run.id }),
		onSuccess: () => {
			setConfirmOpen(false);
			queryClient.invalidateQueries({ queryKey: trpc.runs.getById.queryKey({ id: run.id }) });
			queryClient.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
		},
	});

	return (
		<div className="mt-3">
			<button
				type="button"
				onClick={() => setConfirmOpen(true)}
				disabled={mutation.isPending}
				className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-red-200 bg-red-950/40 border border-red-900/50 rounded-md hover:bg-red-900/40 focus:outline-none focus:ring-1 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
			>
				<OctagonX className={`h-4 w-4 ${mutation.isPending ? 'animate-pulse' : ''}`} />
				{terminateButtonLabel(mutation.isPending)}
			</button>

			<Modal
				open={confirmOpen}
				onClose={() => {
					if (!mutation.isPending) setConfirmOpen(false);
				}}
				title="Terminate run?"
			>
				<p className="text-sm text-zinc-300">{terminateConfirmMessage(run.status)}</p>
				{mutation.isError && (
					<div className="mt-3 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{mutation.error.message}
					</div>
				)}
				<ModalFooter
					primary={
						<button
							type="button"
							onClick={() => mutation.mutate()}
							disabled={mutation.isPending}
							className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded hover:bg-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
						>
							{mutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
							{terminateButtonLabel(mutation.isPending)}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={() => setConfirmOpen(false)}
							disabled={mutation.isPending}
							className="px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
						>
							Cancel
						</button>
					}
				/>
			</Modal>
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
				<RunStatusBadge
					status={run.status as RunStatus}
					timedOut={run.timedOut}
					phase={run.phase}
					reviewVerdict={run.reviewVerdict}
					className="text-sm px-3 py-1"
				/>
			</div>

			{run.status === 'running' && (
				<div className="p-4 bg-violet-950/20 border border-violet-900/30 rounded flex items-start gap-3">
					<Loader2 className="h-5 w-5 text-violet-400 shrink-0 mt-0.5 animate-spin" />
					<div>
						<h3 className="text-xs font-semibold text-violet-200">Running</h3>
						<p className="text-xs text-violet-200/70 mt-1">
							This run is in progress. Terminating it stops the agent and frees its project slot.
						</p>
						{canTerminateRun(run.status) && <TerminateRunButton run={run} />}
					</div>
				</div>
			)}

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
						<div className="flex flex-wrap items-center gap-3">
							{canRetryRun(run.status) && <RetryNowButton run={run} />}
							{canTerminateRun(run.status) && <TerminateRunButton run={run} />}
						</div>
					</div>
				</div>
			)}

			{run.status === 'failed' && run.error && (
				<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex items-start gap-3">
					<AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
					<div>
						<h3 className="text-xs font-semibold text-red-200">
							{run.timedOut ? 'Run Timed Out' : 'Run Failure Error'}
						</h3>
						<p className="text-xs text-red-400/80 mt-1 font-mono whitespace-pre-wrap">
							{run.error}
						</p>
						{canRetryRun(run.status) && <RetryNowButton run={run} />}
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
			{hasPR && run.prTitle && (
				<span className="text-zinc-300" title={run.prTitle}>
					{run.prTitle}
				</span>
			)}
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
							<RunStatusBadge
								status={run.status as RunStatus}
								timedOut={run.timedOut}
								phase={run.phase}
								reviewVerdict={run.reviewVerdict}
							/>
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
						<span className="block text-xs font-medium text-zinc-400">Reasoning</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">
							{run.reasoning ? capitalizeLevel(run.reasoning) : 'Default'}
						</span>
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
	const [activeTab, setActiveTab] = useState<'live' | 'overview' | 'logs'>('live');
	const [outputCursor, setOutputCursor] = useState(0);
	const [outputEvents, setOutputEvents] = useState<LiveOutputEvent[]>([]);
	const [uiOutputTruncated, setUiOutputTruncated] = useState(false);

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

	const outputQuery = useQuery({
		...trpc.runs.getOutput.queryOptions({ runId, after: outputCursor }),
		refetchInterval: (query) =>
			query.state.data?.hasMore ? 100 : runQuery.data?.status === 'running' ? 1000 : false,
	});
	useEffect(() => {
		const page = outputQuery.data;
		if (!page || page.nextCursor === outputCursor) return;
		setOutputEvents((current) => {
			const combined = [...current, ...page.events];
			if (combined.length <= 2_000) return combined;
			setUiOutputTruncated(true);
			return combined.slice(-2_000);
		});
		setOutputCursor(page.nextCursor);
	}, [outputCursor, outputQuery.data]);

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
					onClick={() => setActiveTab('live')}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all cursor-pointer ${
						activeTab === 'live'
							? 'border-b-2 border-violet-500 text-white bg-zinc-800/20'
							: 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<Terminal className="h-4 w-4" />
					Live Output
				</button>
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
			{activeTab === 'live' ? (
				<LiveOutputViewer
					events={outputEvents}
					isRunning={run.status === 'running'}
					isLoading={outputQuery.isLoading}
					retentionBytes={outputQuery.data?.retentionBytes ?? 5_000_000}
					serverTruncated={outputQuery.data?.truncated ?? false}
					uiTruncated={uiOutputTruncated}
				/>
			) : activeTab === 'overview' ? (
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
