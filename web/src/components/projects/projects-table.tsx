import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { Modal, ModalFooter } from '../ui/modal.js';

interface Project {
	id: string;
	name: string;
	repo: string;
	repoRoot: string;
}

interface ProjectsTableProps {
	projects: Project[];
}

export function ProjectsTable({ projects }: ProjectsTableProps) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

	const deleteMutation = useMutation({
		mutationFn: (variables: { id: string }) => trpcClient.projects.delete.mutate(variables),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: trpc.projects.list.queryOptions().queryKey,
			});
			setDeleteTarget(null);
		},
	});

	const handleDeleteConfirm = () => {
		if (deleteTarget) {
			deleteMutation.mutate({ id: deleteTarget.id });
		}
	};

	return (
		<div className="space-y-6">
			<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
				<table className="w-full text-left border-collapse">
					<thead>
						<tr className="bg-zinc-800/30 border-b border-zinc-800">
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								ID
							</th>
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Name
							</th>
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Repository
							</th>
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 w-16"></th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800/60">
						{projects.map((project) => (
							<tr
								key={project.id}
								onClick={() =>
									navigate({ to: '/projects/$projectId', params: { projectId: project.id } })
								}
								className="hover:bg-zinc-800/40 transition-colors cursor-pointer"
							>
								<td className="px-4 py-3 text-sm font-mono text-zinc-300">{project.id}</td>
								<td className="px-4 py-3 text-sm text-zinc-200">{project.name}</td>
								<td className="px-4 py-3 text-sm font-mono text-zinc-300">{project.repo}</td>
								<td className="px-4 py-3 text-sm text-right">
									<div className="flex items-center justify-end gap-1.5">
										<Link
											to="/projects/$projectId"
											params={{ projectId: project.id }}
											className="text-zinc-500 hover:text-zinc-300 p-1.5 rounded hover:bg-zinc-800/60 transition-colors"
											title={`Settings for ${project.name}`}
										>
											<Settings className="w-4 h-4" />
										</Link>
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												setDeleteTarget({ id: project.id, name: project.name });
											}}
											className="text-zinc-500 hover:text-red-400 p-1.5 rounded hover:bg-zinc-800/60 transition-colors"
											title={`Delete ${project.name}`}
										>
											<Trash2 className="w-4 h-4" />
										</button>
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete project">
				<div className="space-y-4">
					<p className="text-sm text-zinc-400 leading-relaxed">
						This will permanently delete{' '}
						<span className="font-semibold text-zinc-200">“{deleteTarget?.name}”</span> (
						<span className="font-mono text-zinc-300">{deleteTarget?.id}</span>). This action cannot
						be undone.
					</p>

					{deleteMutation.isError && (
						<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
							{deleteMutation.error.message}
						</div>
					)}

					<ModalFooter
						primary={
							<button
								type="button"
								onClick={handleDeleteConfirm}
								disabled={deleteMutation.isPending}
								className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-md hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{deleteMutation.isPending ? 'Deleting…' : 'Delete'}
							</button>
						}
						secondary={
							<button
								type="button"
								onClick={() => setDeleteTarget(null)}
								className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors"
							>
								Cancel
							</button>
						}
					/>
				</div>
			</Modal>
		</div>
	);
}
