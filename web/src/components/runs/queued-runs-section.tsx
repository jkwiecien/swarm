import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { formatRelativeTime, formatTimeUntil } from '@/lib/format.js';
import {
	groupQueuedRuns,
	queuedPhaseLabel,
	queuedRunKey,
	queuedWorkItemLabel,
	queuedWorkItemTitle,
	queuedWorkItemUrl,
	REVIEW_GATE_GROUP_LABEL,
	reviewGateSourceEventLabel,
} from '@/lib/queued-runs.js';
import { runTableColumnWidths } from '@/lib/run-table-layout.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import type { QueuedRun } from '@/types/runs.js';
import { Modal, ModalFooter } from '../ui/modal.js';
import { RunStatusBadge } from './run-status-badge.js';

interface QueuedRunsSectionProps {
	items: QueuedRun[];
	/**
	 * Whether to render the Project column. `true` for the global `/runs` view;
	 * `false` for the project-scoped Runs tab, where every row is the same project
	 * — matching {@link RunsTable}'s `showProject`.
	 */
	showProject?: boolean;
}

/**
 * A compact, distinct **Queued** section shown above the Runs table (issue #238):
 * work already enqueued in BullMQ but not yet picked up by the worker, so users
 * see pending work even when nothing is currently running.
 *
 * - Hidden entirely when there is nothing queued — returns `null` so there's no
 *   empty box and no layout shift for the table below.
 * - Rows render in the exact order the server returns them (dispatch priority +
 *   FIFO); this component never re-sorts — it only folds pending review-gate
 *   jobs sharing the same project/repo/PR/head SHA into one logical row via
 *   {@link groupQueuedRuns} (issue #275), so a duplicate raw lifecycle event
 *   (e.g. a Respond-to-review follow-up alongside GitHub's own
 *   `pull_request:synchronize`) doesn't read as two queued Review agents.
 * - Rows are static (not clickable): a queued job has no run detail page yet.
 */
export function QueuedRunsSection({ items, showProject = true }: QueuedRunsSectionProps) {
	// Resolve project display names the same way RunsTable does. Hook order is
	// stable across renders, so the early return below stays after all hooks.
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectsMap = new Map(projectsQuery.data?.map((p) => [p.id, p]) ?? []);
	const columnWidths = runTableColumnWidths(showProject);
	const rows = groupQueuedRuns(items);

	const [confirmOpen, setConfirmOpen] = useState(false);
	const [selectedItem, setSelectedItem] = useState<QueuedRun | null>(null);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const queryClient = useQueryClient();
	const putBackMutation = useMutation({
		mutationFn: (item: QueuedRun) =>
			trpcClient.runs.putBack.mutate({ jobId: item.jobId, projectId: item.projectId }),
		onSuccess: () => {
			setConfirmOpen(false);
			setSelectedItem(null);
			setSuccessMessage('Successfully returned the work item to Backlog.');
			setErrorMessage(null);
			queryClient.invalidateQueries({ queryKey: trpc.runs.queued.queryKey() });
			setTimeout(() => setSuccessMessage(null), 5000);
		},
		onError: (err) => {
			setErrorMessage(err.message || 'An error occurred while putting back the item.');
		},
	});

	if (items.length === 0) return null;

	const handleOpenConfirm = (item: QueuedRun) => {
		setSelectedItem(item);
		setErrorMessage(null);
		setConfirmOpen(true);
	};

	const handleCloseConfirm = () => {
		if (putBackMutation.isPending) return;
		setConfirmOpen(false);
		setSelectedItem(null);
		setErrorMessage(null);
	};

	return (
		<section data-testid="queued-runs-section" className="space-y-2">
			<h2 className="text-sm font-semibold tracking-tight text-zinc-300">
				Queued <span className="text-zinc-500">({rows.length})</span>
			</h2>
			{successMessage && (
				<div className="p-3 bg-emerald-950/40 border border-emerald-800 rounded text-xs text-emerald-200">
					{successMessage}
				</div>
			)}
			<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
				<table className="w-full table-fixed text-left border-collapse">
					<colgroup>
						<col className={columnWidths.phase} />
						{showProject && <col className={columnWidths.project} />}
						<col className={columnWidths.task} />
						<col className={columnWidths.status} />
						<col />
						<col className="w-[120px]" />
					</colgroup>
					<thead>
						<tr className="bg-zinc-800/30 border-b border-zinc-800">
							<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Phase
							</th>
							{showProject && (
								<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
									Project
								</th>
							)}
							<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Task / ID
							</th>
							<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Status
							</th>
							<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Enqueued
							</th>
							<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Actions
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800/60">
						{rows.map((row) => {
							const item = row.representative;
							const isSupportedPhase = item.phaseHint === 'board' || item.phaseHint === 'review';
							const hasLinkedCard = !!item.workItemNodeId;
							const showPutBack = isSupportedPhase && hasLinkedCard;

							return (
								<tr key={queuedRunKey(item)}>
									<td className="px-2 py-2 text-xs font-semibold text-zinc-100">
										{row.isReviewGateGroup ? (
											<div className="flex flex-col gap-1">
												<span>{REVIEW_GATE_GROUP_LABEL}</span>
												<span className="text-[11px] font-normal text-zinc-400">
													{row.sourceEvents.length} source events
												</span>
												<ul className="space-y-0.5 font-mono text-[11px] font-normal text-zinc-500">
													{row.sourceEvents.map((event) => (
														<li key={event.jobId}>{reviewGateSourceEventLabel(event)}</li>
													))}
												</ul>
											</div>
										) : (
											queuedPhaseLabel(item.phaseHint)
										)}
									</td>
									{showProject && (
										<td className="px-2 py-2 text-xs text-zinc-300 font-mono">
											{projectsMap.get(item.projectId)?.name || item.projectId}
										</td>
									)}
									<td className="px-2 py-2 text-xs">
										<div className="flex w-full min-w-0 flex-col gap-1">
											{queuedWorkItemTitle(item) && (
												<span
													className="block w-full truncate text-zinc-200"
													title={queuedWorkItemTitle(item)}
												>
													{queuedWorkItemTitle(item)}
												</span>
											)}
											{queuedWorkItemUrl(item) ? (
												<a
													href={queuedWorkItemUrl(item)}
													target="_blank"
													rel="noopener noreferrer"
													className="inline-flex self-start items-center gap-1 text-zinc-400 hover:text-zinc-300 font-mono hover:underline"
												>
													{queuedWorkItemLabel(item)}
													<ExternalLink className="h-3 w-3" />
												</a>
											) : (
												<span className="font-mono text-zinc-400">{queuedWorkItemLabel(item)}</span>
											)}
										</div>
									</td>
									<td className="px-2 py-2 text-xs">
										<RunStatusBadge status="queued" />
									</td>
									<td className="px-2 py-2 text-xs text-zinc-400">
										{formatRelativeTime(item.enqueuedAt)}
										{item.state === 'delayed' && item.runsAt && (
											<span className="text-zinc-500"> · runs {formatTimeUntil(item.runsAt)}</span>
										)}
									</td>
									<td className="px-2 py-2 text-xs">
										{showPutBack && (
											<button
												type="button"
												onClick={() => handleOpenConfirm(item)}
												className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
											>
												<RotateCcw className="w-3 h-3" />
												Put back
											</button>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			<Modal open={confirmOpen} onClose={handleCloseConfirm} title="Put Back Work Item">
				<div className="space-y-4">
					{errorMessage && (
						<div className="p-3 bg-red-950/40 border border-red-800 rounded text-xs text-red-200">
							{errorMessage}
						</div>
					)}
					<p className="text-xs text-zinc-400">
						Are you sure you want to put this queued work item back? This will cancel the pending
						queue job and return the associated board card to Backlog.
					</p>
					{selectedItem && (
						<div className="p-3 bg-zinc-900/60 border border-zinc-800 rounded text-xs space-y-1">
							<div className="font-semibold text-zinc-200">
								{queuedWorkItemTitle(selectedItem) || 'Work Item'}
							</div>
							<div className="font-mono text-zinc-500">{queuedWorkItemLabel(selectedItem)}</div>
						</div>
					)}
					<ModalFooter
						primary={
							<button
								type="button"
								disabled={putBackMutation.isPending}
								onClick={() => selectedItem && putBackMutation.mutate(selectedItem)}
								className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55"
							>
								{putBackMutation.isPending ? 'Putting back...' : 'Confirm'}
							</button>
						}
						secondary={
							<button
								type="button"
								disabled={putBackMutation.isPending}
								onClick={handleCloseConfirm}
								className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-350 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white transition-colors"
							>
								Cancel
							</button>
						}
					/>
				</div>
			</Modal>
		</section>
	);
}
