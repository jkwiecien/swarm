import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { Settings } from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { rootRoute } from '../__root.js';

function ProjectDetailRouteComponent() {
	const { projectId } = projectDetailRoute.useParams();
	const queryClient = useQueryClient();

	const projectQuery = useQuery({
		...trpc.projects.getById.queryOptions({ id: projectId }),
	});

	const [name, setName] = useState('');
	const [repo, setRepo] = useState('');
	const [repoRoot, setRepoRoot] = useState('');
	const [worktreeRoot, setWorktreeRoot] = useState('');
	const [baseBranch, setBaseBranch] = useState('');
	const [branchPrefix, setBranchPrefix] = useState('');

	const project = projectQuery.data;

	const handleInputChange =
		(setter: (val: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
			setter(e.target.value);
			updateMutation.reset();
		};

	useEffect(() => {
		if (project) {
			setName(project.name);
			setRepo(project.repo);
			setRepoRoot(project.repoRoot);
			setWorktreeRoot(project.worktreeRoot ?? '');
			setBaseBranch(project.baseBranch ?? '');
			setBranchPrefix(project.branchPrefix ?? '');
		}
	}, [project]);

	const updateMutation = useMutation({
		mutationFn: (variables: {
			id: string;
			name: string;
			repo: string;
			repoRoot: string;
			worktreeRoot: string;
			baseBranch: string;
			branchPrefix: string;
		}) => trpcClient.projects.update.mutate(variables),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: trpc.projects.getById.queryOptions({ id: projectId }).queryKey,
			});
			queryClient.invalidateQueries({
				queryKey: trpc.projects.list.queryOptions().queryKey,
			});
		},
	});

	const isDirty = useMemo(() => {
		if (!project) return false;
		return (
			name !== project.name ||
			repo !== project.repo ||
			repoRoot !== project.repoRoot ||
			worktreeRoot !== (project.worktreeRoot ?? '') ||
			baseBranch !== (project.baseBranch ?? '') ||
			branchPrefix !== (project.branchPrefix ?? '')
		);
	}, [project, name, repo, repoRoot, worktreeRoot, baseBranch, branchPrefix]);

	const handleReset = () => {
		if (project) {
			setName(project.name);
			setRepo(project.repo);
			setRepoRoot(project.repoRoot);
			setWorktreeRoot(project.worktreeRoot ?? '');
			setBaseBranch(project.baseBranch ?? '');
			setBranchPrefix(project.branchPrefix ?? '');
			updateMutation.reset();
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		updateMutation.mutate({
			id: projectId,
			name,
			repo,
			repoRoot,
			worktreeRoot,
			baseBranch,
			branchPrefix,
		});
	};

	if (projectQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading project settings…</div>;
	}

	if (projectQuery.isError) {
		return (
			<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex flex-col gap-2">
				<h3 className="text-sm font-semibold text-red-200">Error Loading Project</h3>
				<p className="text-xs text-red-400/80 font-mono">{projectQuery.error.message}</p>
				<Link
					to="/projects"
					className="text-xs font-semibold text-zinc-300 hover:text-white transition-colors underline mt-2 inline-block"
				>
					Back to Projects
				</Link>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Breadcrumb */}
			<div className="text-xs font-mono text-zinc-500">
				<Link to="/projects" className="hover:text-zinc-300 transition-colors">
					projects
				</Link>{' '}
				/ <span className="text-zinc-300 font-semibold select-all">{projectId}</span>
			</div>

			{/* Page Title */}
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
					{project?.name || 'Project Settings'}
				</h1>
				<p className="text-xs text-zinc-500 mt-1 font-mono">{projectId}</p>
			</div>

			{/* Horizontal Tab Bar */}
			<div className="flex border-b border-zinc-800">
				<button
					type="button"
					className="flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all border-b-2 border-violet-500 text-white bg-zinc-800/20"
				>
					<Settings className="h-4 w-4 text-violet-400" />
					General Settings
				</button>
			</div>

			{/* Form Card */}
			<div className="border border-zinc-800 rounded-lg bg-[#0F0F11]/40 p-6 shadow-sm">
				<form onSubmit={handleSubmit} className="space-y-6">
					<div>
						<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
							General Configuration
						</h2>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
							{/* Name */}
							<div>
								<label htmlFor="name" className="block text-xs font-medium text-zinc-400 mb-1">
									Name <span className="text-red-500">*</span>
								</label>
								<input
									type="text"
									id="name"
									value={name}
									onChange={handleInputChange(setName)}
									disabled={updateMutation.isPending}
									required
									placeholder="Project Name"
									className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
								/>
								<p className="text-xs text-zinc-500 mt-1">
									Display name for this project shown in the dashboard.
								</p>
							</div>

							{/* Repo */}
							<div>
								<label htmlFor="repo" className="block text-xs font-medium text-zinc-400 mb-1">
									Repository <span className="text-red-500">*</span>
								</label>
								<input
									type="text"
									id="repo"
									value={repo}
									onChange={handleInputChange(setRepo)}
									disabled={updateMutation.isPending}
									required
									pattern="[^/]+/[^/]+"
									placeholder="owner/repo"
									className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
								/>
								<p className="text-xs text-zinc-500 mt-1">
									The GitHub repository this project operates on, in "owner/repo" format.
								</p>
							</div>

							{/* Repo Root */}
							<div>
								<label htmlFor="repoRoot" className="block text-xs font-medium text-zinc-400 mb-1">
									Local Repository Root <span className="text-red-500">*</span>
								</label>
								<input
									type="text"
									id="repoRoot"
									value={repoRoot}
									onChange={handleInputChange(setRepoRoot)}
									disabled={updateMutation.isPending}
									required
									placeholder="/Users/username/Projects/my-project"
									className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
								/>
								<p className="text-xs text-zinc-500 mt-1">
									Absolute path to the main repository checkout on the developer's machine.
								</p>
							</div>

							{/* Worktree Root */}
							<div>
								<label
									htmlFor="worktreeRoot"
									className="block text-xs font-medium text-zinc-400 mb-1"
								>
									Worktree Directory <span className="text-red-500">*</span>
								</label>
								<input
									type="text"
									id="worktreeRoot"
									value={worktreeRoot}
									onChange={handleInputChange(setWorktreeRoot)}
									disabled={updateMutation.isPending}
									required
									placeholder=".swarm-workspaces"
									className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
								/>
								<p className="text-xs text-zinc-500 mt-1">
									Directory under the repository root where task-specific git worktrees live.
								</p>
							</div>

							{/* Base Branch */}
							<div>
								<label
									htmlFor="baseBranch"
									className="block text-xs font-medium text-zinc-400 mb-1"
								>
									Base Branch <span className="text-red-500">*</span>
								</label>
								<input
									type="text"
									id="baseBranch"
									value={baseBranch}
									onChange={handleInputChange(setBaseBranch)}
									disabled={updateMutation.isPending}
									required
									placeholder="main"
									className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
								/>
								<p className="text-xs text-zinc-500 mt-1">
									Branch task worktrees are cut from and PRs target.
								</p>
							</div>

							{/* Branch Prefix */}
							<div>
								<label
									htmlFor="branchPrefix"
									className="block text-xs font-medium text-zinc-400 mb-1"
								>
									Branch Prefix
								</label>
								<input
									type="text"
									id="branchPrefix"
									value={branchPrefix}
									onChange={handleInputChange(setBranchPrefix)}
									disabled={updateMutation.isPending}
									placeholder="issue-"
									className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
								/>
								<p className="text-xs text-zinc-500 mt-1">
									Prefix for task branch names (convention is 'issue-').
								</p>
							</div>
						</div>
					</div>

					{/* Feedback Banners */}
					{updateMutation.isSuccess && (
						<div className="p-3 bg-emerald-950/20 border border-emerald-900/30 text-sm text-emerald-400 rounded">
							Project settings saved successfully.
						</div>
					)}

					{updateMutation.isError && (
						<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
							Failed to save settings: {updateMutation.error.message}
						</div>
					)}

					{/* Action Buttons */}
					<div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
						<button
							type="submit"
							disabled={updateMutation.isPending || !isDirty}
							className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed"
						>
							{updateMutation.isPending ? 'Saving…' : 'Save Changes'}
						</button>
						<button
							type="button"
							onClick={handleReset}
							disabled={updateMutation.isPending || !isDirty}
							className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
						>
							Reset
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

export const projectDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects/$projectId',
	component: ProjectDetailRouteComponent,
});
