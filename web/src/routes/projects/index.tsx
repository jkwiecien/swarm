import { createRoute } from '@tanstack/react-router';
import { FolderGit2 } from 'lucide-react';
import { rootRoute } from '../__root.js';

function ProjectsPlaceholder() {
	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Projects</h1>
			<div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-zinc-800 bg-[#0F0F11]/40 p-12 text-center shadow-sm">
				<FolderGit2 className="h-12 w-12 stroke-1 text-zinc-700" />
				<p className="text-sm text-zinc-400">Project management is coming in a future update.</p>
			</div>
		</div>
	);
}

export const projectsIndexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects',
	component: ProjectsPlaceholder,
});
