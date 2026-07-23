import { useQuery } from '@tanstack/react-query';
import { formatRelativeTime } from '@/lib/format.js';
import { trpc } from '@/lib/trpc.js';
import type { WorkerEnrollmentSummary, WorkerRow } from '@/types/workers.js';

/**
 * The read-only worker roster (issue #133): one row per worker the viewer may
 * see, with connectivity, declared CLI capabilities, the run it is executing,
 * and its enrollment/approval state per visible project.
 *
 * Deliberately actionless — no row menu, form, or control. Worker start/stop,
 * force-disconnect, enrollment approval, and assignment routing are out of scope
 * for this screen, so there is nothing here to click except the run link.
 */

interface WorkersTableProps {
	workers: WorkerRow[];
}

const ENROLLMENT_LABELS: Record<WorkerEnrollmentSummary['status'], string> = {
	pending: 'Pending',
	active: 'Active',
	suspended: 'Suspended',
};

const ENROLLMENT_BADGE_CLASSES: Record<WorkerEnrollmentSummary['status'], string> = {
	pending: 'text-amber-400 bg-amber-950/20 border-amber-900/30',
	active: 'text-emerald-400 bg-emerald-950/20 border-emerald-900/30',
	suspended: 'text-red-400 bg-red-950/20 border-red-900/30',
};

/** Online is a live status dot; offline stays neutral with its last-seen time beside it. */
function ConnectionCell({ worker }: { worker: WorkerRow }) {
	if (worker.connection === 'online') {
		return (
			<span className="inline-flex items-center gap-2 text-sm text-zinc-200">
				<span className="h-2 w-2 rounded-full bg-emerald-500 ring-4 ring-emerald-500/10" />
				Online
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-2 text-sm text-zinc-400">
			<span className="h-2 w-2 rounded-full bg-zinc-600 ring-4 ring-zinc-600/10" />
			Offline
			<span
				className="text-xs text-zinc-500"
				title={worker.lastSeenAt ? new Date(worker.lastSeenAt).toLocaleString() : undefined}
			>
				{worker.lastSeenAt ? `· ${formatRelativeTime(worker.lastSeenAt)}` : '· Never connected'}
			</span>
		</span>
	);
}

export function WorkersTable({ workers }: WorkersTableProps) {
	// Resolve project display names the same way RunsTable does; the roster falls
	// back to the raw project id when this auxiliary lookup is unavailable.
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectNames = new Map(projectsQuery.data?.map((p) => [p.id, p.name]) ?? []);

	return (
		<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
			<table className="w-full text-left border-collapse">
				<thead>
					<tr className="bg-zinc-800/30 border-b border-zinc-800">
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Machine
						</th>
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Owner
						</th>
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Status
						</th>
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Capabilities
						</th>
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Active run
						</th>
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Enrollment
						</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-zinc-800/60">
					{workers.map((worker) => (
						<tr key={worker.workerId} className="hover:bg-zinc-800/40 transition-colors">
							<td className="px-3 py-3 text-sm font-medium text-zinc-100">{worker.displayName}</td>
							<td className="px-3 py-3 text-sm text-zinc-300">
								{worker.owner ? (
									<span title={worker.owner.identifier}>{worker.owner.displayName}</span>
								) : (
									<span className="text-zinc-500">—</span>
								)}
							</td>
							<td className="px-3 py-3">
								<ConnectionCell worker={worker} />
							</td>
							<td className="px-3 py-3">
								<div className="flex flex-wrap gap-1">
									{worker.capabilities.length > 0 ? (
										worker.capabilities.map((cli) => (
											<span
												key={cli}
												className="px-2 py-0.5 text-[10px] uppercase font-mono font-bold tracking-wider bg-zinc-850 text-zinc-400 rounded border border-zinc-800"
											>
												{cli}
											</span>
										))
									) : (
										<span className="text-sm text-zinc-500">—</span>
									)}
								</div>
							</td>
							<td className="px-3 py-3 text-sm font-mono">
								{worker.currentRunId ? (
									<a
										href={`/runs/${worker.currentRunId}`}
										className="text-violet-400 hover:text-violet-300 hover:underline"
									>
										{worker.currentRunId}
									</a>
								) : (
									<span className="text-zinc-500">—</span>
								)}
							</td>
							<td className="px-3 py-3">
								{worker.enrollments.length > 0 ? (
									<ul className="space-y-1">
										{worker.enrollments.map((enrollment) => (
											<li
												key={enrollment.projectId}
												className="flex items-center gap-2 text-xs text-zinc-300"
											>
												<span className="font-mono">
													{projectNames.get(enrollment.projectId) ?? enrollment.projectId}
												</span>
												<span
													className={`px-2 py-0.5 text-[10px] font-semibold rounded-full border ${ENROLLMENT_BADGE_CLASSES[enrollment.status]}`}
												>
													{ENROLLMENT_LABELS[enrollment.status]}
												</span>
											</li>
										))}
									</ul>
								) : (
									<span className="text-xs text-zinc-500">Not enrolled</span>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
