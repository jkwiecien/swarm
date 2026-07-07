import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { FolderGit2 } from 'lucide-react';
import { trpc } from '@/lib/trpc.js';
import { version } from '../../../../package.json';

export function Sidebar() {
	const currentPath = useRouterState({ select: (s) => s.location.pathname });
	const pingQuery = useQuery(trpc.ping.ping.queryOptions());

	return (
		<div className="flex w-full md:w-64 flex-col justify-between border-r border-zinc-800 bg-[#0F0F11]">
			<div>
				<div className="flex h-14 items-center justify-between border-b border-zinc-850 px-4">
					<span className="text-sm font-semibold text-zinc-100">SWARM</span>
					<span className="px-2 py-0.5 text-[10px] uppercase font-mono font-bold tracking-wider bg-zinc-850 text-zinc-400 rounded border border-zinc-800">
						v{version}
					</span>
				</div>
				<nav className="space-y-1 p-2">
					<div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
						Workspace
					</div>
					<Link
						to="/projects"
						className={
							currentPath.startsWith('/projects')
								? 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium bg-zinc-800/40 text-zinc-100'
								: 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800/40'
						}
					>
						<FolderGit2 className="h-4 w-4" />
						Projects
					</Link>
				</nav>
			</div>
			<div className="flex items-center gap-2 border-t border-zinc-850 p-4">
				<span
					className={
						pingQuery.isSuccess
							? 'h-2 w-2 rounded-full bg-emerald-500 ring-4 ring-emerald-500/10'
							: pingQuery.isError
								? 'h-2 w-2 rounded-full bg-red-500 ring-4 ring-red-500/10'
								: 'h-2 w-2 rounded-full bg-zinc-600 ring-4 ring-zinc-600/10'
					}
				/>
				<span className="text-xs text-zinc-500">
					{pingQuery.isSuccess ? 'Connected' : pingQuery.isError ? 'Disconnected' : 'Connecting…'}
				</span>
			</div>
		</div>
	);
}
