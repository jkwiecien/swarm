import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { Modal, ModalFooter } from '../ui/modal.js';

interface ProjectCreateDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ProjectCreateDialog({ open, onOpenChange }: ProjectCreateDialogProps) {
	const queryClient = useQueryClient();
	const [id, setId] = useState('');
	const [name, setName] = useState('');
	const [repo, setRepo] = useState('');
	const [repoRoot, setRepoRoot] = useState('');

	const mutation = useMutation({
		mutationFn: (newProject: { id: string; name: string; repo: string; repoRoot: string }) =>
			trpcClient.projects.create.mutate(newProject),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: trpc.projects.list.queryOptions().queryKey,
			});
			setId('');
			setName('');
			setRepo('');
			setRepoRoot('');
			onOpenChange(false);
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		mutation.mutate({ id, name, repo, repoRoot });
	};

	return (
		<Modal open={open} onClose={() => onOpenChange(false)} title="New Project">
			<form onSubmit={handleSubmit} className="space-y-4">
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<label htmlFor="project-id" className="block text-xs font-medium text-zinc-400 mb-1">
							ID <span className="text-red-500">*</span>
						</label>
						<input
							type="text"
							id="project-id"
							value={id}
							onChange={(e) => setId(e.target.value)}
							required
							pattern="[a-z0-9-]+"
							placeholder="my-project"
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono"
						/>
					</div>
					<div>
						<label htmlFor="project-name" className="block text-xs font-medium text-zinc-400 mb-1">
							Name <span className="text-red-500">*</span>
						</label>
						<input
							type="text"
							id="project-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							placeholder="My Project"
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
						/>
					</div>
					<div>
						<label htmlFor="project-repo" className="block text-xs font-medium text-zinc-400 mb-1">
							Repo <span className="text-red-500">*</span>
						</label>
						<input
							type="text"
							id="project-repo"
							value={repo}
							onChange={(e) => setRepo(e.target.value)}
							required
							pattern="[^/]+/[^/]+"
							placeholder="owner/repo"
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono"
						/>
					</div>
					<div>
						<label
							htmlFor="project-reporoot"
							className="block text-xs font-medium text-zinc-400 mb-1"
						>
							Repo Root <span className="text-red-500">*</span>
						</label>
						<input
							type="text"
							id="project-reporoot"
							value={repoRoot}
							onChange={(e) => setRepoRoot(e.target.value)}
							required
							placeholder="/Users/you/code/my-repo"
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono"
						/>
					</div>
				</div>

				{mutation.isError && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{mutation.error.message}
					</div>
				)}

				<ModalFooter
					primary={
						<button
							type="submit"
							disabled={mutation.isPending}
							className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{mutation.isPending ? 'Creating…' : 'Create Project'}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={() => onOpenChange(false)}
							className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors"
						>
							Cancel
						</button>
					}
				/>
			</form>
		</Modal>
	);
}
