import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { formatRelativeTime, formatTimeUntil } from '@/lib/format.js';
import {
	queuedPhaseLabel,
	queuedRunKey,
	queuedWorkItemLabel,
	queuedWorkItemTitle,
	queuedWorkItemUrl,
} from '@/lib/queued-runs.js';
import { runTableColumnWidths } from '@/lib/run-table-layout.js';
import { trpc } from '@/lib/trpc.js';
import type { QueuedRun } from '@/types/runs.js';
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
 *   FIFO); this component never re-sorts.
 * - Rows are static (not clickable): a queued job has no run detail page yet.
 */
export function QueuedRunsSection({ items, showProject = true }: QueuedRunsSectionProps) {
	// Resolve project display names the same way RunsTable does. Hook order is
	// stable across renders, so the early return below stays after all hooks.
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectsMap = new Map(projectsQuery.data?.map((p) => [p.id, p]) ?? []);
	const columnWidths = runTableColumnWidths(showProject);

	if (items.length === 0) return null;

	return (
		<section data-testid="queued-runs-section" className="space-y-2">
			<h2 className="text-sm font-semibold tracking-tight text-zinc-300">
				Queued <span className="text-zinc-500">({items.length})</span>
			</h2>
			<div className="border border-zinc-800 rounded-md overflow-hidden bg-[#0F0F11]/20 shadow-sm">
				<table className="w-full table-fixed text-left border-collapse">
					<colgroup>
						<col className={columnWidths.phase} />
						{showProject && <col className={columnWidths.project} />}
						<col className={columnWidths.task} />
						<col className="w-[10%]" />
						<col />
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
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800/60">
						{items.map((item) => (
							<tr key={queuedRunKey(item)}>
								<td className="px-2 py-2 text-xs font-semibold text-zinc-100">
									{queuedPhaseLabel(item.phaseHint)}
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
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
