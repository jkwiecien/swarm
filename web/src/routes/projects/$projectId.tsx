import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { Cpu, Settings } from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { trpc, trpcClient } from '@/lib/trpc.js';
import type { AgentConfig, AgentsConfig } from '../../../../src/config/schema.js';
import type { AgentCli } from '../../../../src/harness/agent-cli.js';
import { AGENT_MODELS } from '../../../../src/harness/models.js';
import { rootRoute } from '../__root.js';

const PHASES = [
	'planning',
	'implementation',
	'review',
	'respondToReview',
	'respondToCi',
	'resolveConflicts',
] as const;

const PHASE_LABELS: Record<(typeof PHASES)[number], { label: string; code: string }> = {
	planning: { label: 'Planning', code: 'planning' },
	implementation: { label: 'Implementation', code: 'implementation' },
	review: { label: 'Review', code: 'review' },
	respondToReview: { label: 'Respond to Review', code: 'respondToReview' },
	respondToCi: { label: 'Respond to CI', code: 'respondToCi' },
	resolveConflicts: { label: 'Resolve Conflicts', code: 'resolveConflicts' },
};

function getModelDefaultLabel(
	cli: string,
	projectDefaults?: Record<string, string | undefined>,
): string {
	const defaultModel =
		projectDefaults?.[cli] ||
		{
			claude: 'sonnet',
			codex: 'gpt-5.6-terra',
			antigravity: 'Gemini 3.5 Flash (Medium)',
		}[cli] ||
		'Unset';

	const displayModel =
		defaultModel === 'sonnet'
			? 'Sonnet'
			: defaultModel === 'opus'
				? 'Opus'
				: defaultModel === 'fable'
					? 'Fable'
					: defaultModel === 'haiku'
						? 'Haiku'
						: defaultModel;

	return `Default (${displayModel})`;
}

function isPhaseConfigDirty(local: AgentConfig = {}, db: AgentConfig = {}): boolean {
	return (
		(local.cli ?? '') !== (db.cli ?? '') ||
		(local.model ?? '') !== (db.model ?? '') ||
		(local.timeoutMs ?? '') !== (db.timeoutMs ?? '')
	);
}

function cleanAgentsConfig(agents: AgentsConfig): AgentsConfig | undefined {
	const cleanAgents: AgentsConfig = {};
	if (agents.defaults) {
		cleanAgents.defaults = agents.defaults;
	}
	for (const phase of PHASES) {
		const phaseConfig = agents[phase];
		if (!phaseConfig) continue;
		const cleaned = cleanAgentConfig(phaseConfig);
		if (cleaned) cleanAgents[phase] = cleaned;
	}
	return Object.keys(cleanAgents).length > 0 ? cleanAgents : undefined;
}

function cleanAgentConfig({ cli, model, timeoutMs }: AgentConfig): AgentConfig | undefined {
	if (!cli && !model && !timeoutMs) return undefined;
	return { cli, model, timeoutMs };
}

interface GeneralSettingsFormProps {
	name: string;
	repo: string;
	repoRoot: string;
	worktreeRoot: string;
	baseBranch: string;
	branchPrefix: string;
	maxConcurrentJobs: string;
	maxConcurrentJobsError?: string;
	setName: (val: string) => void;
	setRepo: (val: string) => void;
	setRepoRoot: (val: string) => void;
	setWorktreeRoot: (val: string) => void;
	setBaseBranch: (val: string) => void;
	setBranchPrefix: (val: string) => void;
	setMaxConcurrentJobs: (val: string) => void;
	handleInputChange: (
		setter: (val: string) => void,
	) => (e: React.ChangeEvent<HTMLInputElement>) => void;
	handleSubmit: (e: React.FormEvent) => void;
	handleReset: () => void;
	isDirty: boolean;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
	errorMessage?: string;
}

function GeneralSettingsForm({
	name,
	repo,
	repoRoot,
	worktreeRoot,
	baseBranch,
	branchPrefix,
	maxConcurrentJobs,
	maxConcurrentJobsError,
	setName,
	setRepo,
	setRepoRoot,
	setWorktreeRoot,
	setBaseBranch,
	setBranchPrefix,
	setMaxConcurrentJobs,
	handleInputChange,
	handleSubmit,
	handleReset,
	isDirty,
	isPending,
	isSuccess,
	isError,
	errorMessage,
}: GeneralSettingsFormProps) {
	return (
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
								disabled={isPending}
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
								disabled={isPending}
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
								disabled={isPending}
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
								disabled={isPending}
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
							<label htmlFor="baseBranch" className="block text-xs font-medium text-zinc-400 mb-1">
								Base Branch <span className="text-red-500">*</span>
							</label>
							<input
								type="text"
								id="baseBranch"
								value={baseBranch}
								onChange={handleInputChange(setBaseBranch)}
								disabled={isPending}
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
								disabled={isPending}
								placeholder="issue-"
								className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
							/>
							<p className="text-xs text-zinc-500 mt-1">
								Prefix for task branch names (convention is 'issue-').
							</p>
						</div>

						<div>
							<label
								htmlFor="maxConcurrentJobs"
								className="block text-xs font-medium text-zinc-400 mb-1"
							>
								Maximum Concurrent Jobs <span className="text-red-500">*</span>
							</label>
							<input
								type="number"
								id="maxConcurrentJobs"
								value={maxConcurrentJobs}
								onChange={handleInputChange(setMaxConcurrentJobs)}
								disabled={isPending}
								className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
							/>
							{maxConcurrentJobsError ? (
								<p className="text-xs text-red-400 mt-1">{maxConcurrentJobsError}</p>
							) : (
								<p className="text-xs text-zinc-500 mt-1">
									Maximum jobs this project may run at once. Must be a positive whole number.
								</p>
							)}
						</div>
					</div>
				</div>

				{/* Feedback Banners */}
				{isSuccess && (
					<div className="p-3 bg-emerald-950/20 border border-emerald-900/30 text-sm text-emerald-400 rounded">
						Project settings saved successfully.
					</div>
				)}

				{isError && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						Failed to save settings: {errorMessage}
					</div>
				)}

				{/* Action Buttons */}
				<div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
					<button
						type="submit"
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed"
					>
						{isPending ? 'Saving…' : 'Save Changes'}
					</button>
					<button
						type="button"
						onClick={handleReset}
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
					>
						Reset
					</button>
				</div>
			</form>
		</div>
	);
}

interface AgentConfigurationFormProps {
	agents: AgentsConfig;
	handleCliChange: (phase: keyof AgentsConfig, value: string) => void;
	handleModelChange: (phase: keyof AgentsConfig, value: string) => void;
	handleTimeoutChange: (phase: keyof AgentsConfig, value: string) => void;
	handleSubmit: (e: React.FormEvent) => void;
	handleReset: () => void;
	isDirty: boolean;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
	errorMessage?: string;
}

function AgentConfigurationForm({
	agents,
	handleCliChange,
	handleModelChange,
	handleTimeoutChange,
	handleSubmit,
	handleReset,
	isDirty,
	isPending,
	isSuccess,
	isError,
	errorMessage,
}: AgentConfigurationFormProps) {
	return (
		<div className="border border-zinc-800 rounded-lg bg-[#0F0F11]/40 p-6 shadow-sm">
			<form onSubmit={handleSubmit} className="space-y-6">
				<div>
					<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
						Agent Configuration
					</h2>
					<p className="text-xs text-zinc-400 mb-4">
						Configure which agent CLI and model overrides are used for each pipeline phase. Omitting
						values will default to the pipeline's coded default settings.
					</p>

					<div className="border border-zinc-800 rounded-md overflow-hidden bg-[#0F0F11]/20 shadow-sm">
						<table className="w-full text-left border-collapse">
							<thead>
								<tr className="bg-zinc-800/30 border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-400 font-semibold">
									<th className="px-4 py-3">Phase</th>
									<th className="px-4 py-3">Agent CLI</th>
									<th className="px-4 py-3">Model</th>
									<th className="px-4 py-3">Timeout (ms)</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-zinc-800/60">
								{PHASES.map((phase) => {
									const phaseLabel = PHASE_LABELS[phase];
									const currentConfig = agents[phase] ?? {};
									const selectedCli = currentConfig.cli;
									const selectedModel = currentConfig.model;
									const timeoutMs = currentConfig.timeoutMs;

									const modelOptions = selectedCli ? AGENT_MODELS[selectedCli] : [];

									return (
										<tr key={phase} className="hover:bg-zinc-800/40 transition-colors">
											<td className="px-4 py-3.5">
												<div className="text-sm font-medium text-zinc-200">{phaseLabel.label}</div>
												<div className="text-xs text-zinc-500 font-mono select-all">
													{phaseLabel.code}
												</div>
											</td>
											<td className="px-4 py-3.5">
												<select
													value={selectedCli ?? ''}
													onChange={(e) => handleCliChange(phase, e.target.value)}
													disabled={isPending}
													className="block w-full max-w-[200px] px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500 transition-shadow"
												>
													<option value="">Default (Unset)</option>
													<option value="claude">Claude</option>
													<option value="antigravity">Antigravity</option>
													<option value="codex">Codex</option>
												</select>
											</td>
											<td className="px-4 py-3.5">
												<select
													value={selectedModel ?? ''}
													onChange={(e) => handleModelChange(phase, e.target.value)}
													disabled={isPending || !selectedCli}
													className="block w-full max-w-[300px] px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500 font-mono transition-shadow"
												>
													<option value="">
														{selectedCli
															? getModelDefaultLabel(selectedCli, agents.defaults)
															: 'Default (Unset)'}
													</option>
													{modelOptions.map((model) => (
														<option key={model} value={model}>
															{model}
														</option>
													))}
												</select>
											</td>
											<td className="px-4 py-3.5">
												<input
													type="number"
													min="1"
													value={timeoutMs ?? ''}
													onChange={(e) => handleTimeoutChange(phase, e.target.value)}
													disabled={isPending}
													placeholder="No timeout"
													className="block w-full max-w-[160px] px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 font-mono"
												/>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</div>

				{/* Feedback Banners */}
				{isSuccess && (
					<div className="p-3 bg-emerald-950/20 border border-emerald-900/30 text-sm text-emerald-400 rounded">
						Agent configuration saved successfully.
					</div>
				)}

				{isError && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						Failed to save configuration: {errorMessage}
					</div>
				)}

				{/* Action Buttons */}
				<div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
					<button
						type="submit"
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed"
					>
						{isPending ? 'Saving…' : 'Save Changes'}
					</button>
					<button
						type="button"
						onClick={handleReset}
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
					>
						Reset
					</button>
				</div>
			</form>
		</div>
	);
}

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
	const [maxConcurrentJobs, setMaxConcurrentJobs] = useState('');
	const [maxConcurrentJobsError, setMaxConcurrentJobsError] = useState<string>();

	const [activeTab, setActiveTab] = useState<'general' | 'agents'>('general');
	const [agents, setAgents] = useState<AgentsConfig>({});

	const project = projectQuery.data;

	const handleInputChange =
		(setter: (val: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
			setter(e.target.value);
			setMaxConcurrentJobsError(undefined);
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
			setMaxConcurrentJobs(String(project.maxConcurrentJobs));
			setMaxConcurrentJobsError(undefined);
			setAgents(project.agents ?? {});
		}
	}, [project]);

	const updateMutation = useMutation({
		mutationFn: (variables: {
			id: string;
			name?: string;
			repo?: string;
			repoRoot?: string;
			worktreeRoot?: string;
			baseBranch?: string;
			branchPrefix?: string;
			maxConcurrentJobs?: number;
			agents?: AgentsConfig;
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
			branchPrefix !== (project.branchPrefix ?? '') ||
			maxConcurrentJobs !== String(project.maxConcurrentJobs)
		);
	}, [project, name, repo, repoRoot, worktreeRoot, baseBranch, branchPrefix, maxConcurrentJobs]);

	const isAgentsDirty = useMemo(() => {
		if (!project) return false;
		const projectAgents = project.agents ?? {};
		const localDefaults = agents.defaults ?? {};
		const dbDefaults = projectAgents.defaults ?? {};
		const hasDefaultChange = (['claude', 'antigravity', 'codex'] as const).some(
			(cli) => (localDefaults[cli] ?? '') !== (dbDefaults[cli] ?? ''),
		);
		if (hasDefaultChange) return true;

		return PHASES.some((phase) => isPhaseConfigDirty(agents[phase], projectAgents[phase]));
	}, [project, agents]);

	const handleCliChange = (phase: keyof AgentsConfig, value: string) => {
		const cli = value ? (value as AgentCli) : undefined;
		setAgents((prev) => {
			const updatedPhase: AgentConfig = { ...(prev[phase] as AgentConfig) };
			if (cli) {
				updatedPhase.cli = cli;
				if (updatedPhase.model && !AGENT_MODELS[cli].includes(updatedPhase.model)) {
					updatedPhase.model = undefined;
				}
			} else {
				updatedPhase.cli = undefined;
				updatedPhase.model = undefined;
			}
			return {
				...prev,
				[phase]: updatedPhase,
			};
		});
		updateMutation.reset();
	};

	const handleModelChange = (phase: keyof AgentsConfig, value: string) => {
		setAgents((prev) => ({
			...prev,
			[phase]: {
				...prev[phase],
				model: value || undefined,
			},
		}));
		updateMutation.reset();
	};

	const handleTimeoutChange = (phase: keyof AgentsConfig, value: string) => {
		setAgents((prev) => ({
			...prev,
			[phase]: { ...prev[phase], timeoutMs: value ? Number(value) : undefined },
		}));
		updateMutation.reset();
	};

	const handleAgentsReset = () => {
		if (project) {
			setAgents(project.agents ?? {});
			updateMutation.reset();
		}
	};

	const handleAgentsSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const finalAgents = cleanAgentsConfig(agents);
		updateMutation.mutate({
			id: projectId,
			agents: finalAgents,
		});
	};

	const handleReset = () => {
		if (project) {
			setName(project.name);
			setRepo(project.repo);
			setRepoRoot(project.repoRoot);
			setWorktreeRoot(project.worktreeRoot ?? '');
			setBaseBranch(project.baseBranch ?? '');
			setBranchPrefix(project.branchPrefix ?? '');
			setMaxConcurrentJobs(String(project.maxConcurrentJobs));
			setMaxConcurrentJobsError(undefined);
			updateMutation.reset();
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const parsedMaxConcurrentJobs = Number(maxConcurrentJobs);
		if (!Number.isInteger(parsedMaxConcurrentJobs) || parsedMaxConcurrentJobs < 1) {
			setMaxConcurrentJobsError('Maximum concurrent jobs must be a positive whole number.');
			return;
		}
		setMaxConcurrentJobsError(undefined);
		updateMutation.mutate({
			id: projectId,
			name,
			repo,
			repoRoot,
			worktreeRoot,
			baseBranch,
			branchPrefix,
			maxConcurrentJobs: parsedMaxConcurrentJobs,
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
					onClick={() => {
						setActiveTab('general');
						updateMutation.reset();
					}}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all border-b-2 ${
						activeTab === 'general'
							? 'border-violet-500 text-white bg-zinc-800/20'
							: 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<Settings className="h-4 w-4 text-violet-400" />
					General Settings
				</button>
				<button
					type="button"
					onClick={() => {
						setActiveTab('agents');
						updateMutation.reset();
					}}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all border-b-2 ${
						activeTab === 'agents'
							? 'border-violet-500 text-white bg-zinc-800/20'
							: 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<Cpu className="h-4 w-4 text-violet-400" />
					Agent Configuration
				</button>
			</div>

			{/* Form Card - General Settings */}
			{activeTab === 'general' && (
				<GeneralSettingsForm
					name={name}
					repo={repo}
					repoRoot={repoRoot}
					worktreeRoot={worktreeRoot}
					baseBranch={baseBranch}
					branchPrefix={branchPrefix}
					maxConcurrentJobs={maxConcurrentJobs}
					maxConcurrentJobsError={maxConcurrentJobsError}
					setName={setName}
					setRepo={setRepo}
					setRepoRoot={setRepoRoot}
					setWorktreeRoot={setWorktreeRoot}
					setBaseBranch={setBaseBranch}
					setBranchPrefix={setBranchPrefix}
					setMaxConcurrentJobs={setMaxConcurrentJobs}
					handleInputChange={handleInputChange}
					handleSubmit={handleSubmit}
					handleReset={handleReset}
					isDirty={isDirty}
					isPending={updateMutation.isPending}
					isSuccess={updateMutation.isSuccess}
					isError={updateMutation.isError}
					errorMessage={updateMutation.error?.message}
				/>
			)}

			{/* Form Card - Agent Configuration */}
			{activeTab === 'agents' && (
				<AgentConfigurationForm
					agents={agents}
					handleCliChange={handleCliChange}
					handleModelChange={handleModelChange}
					handleTimeoutChange={handleTimeoutChange}
					handleSubmit={handleAgentsSubmit}
					handleReset={handleAgentsReset}
					isDirty={isAgentsDirty}
					isPending={updateMutation.isPending}
					isSuccess={updateMutation.isSuccess}
					isError={updateMutation.isError}
					errorMessage={updateMutation.error?.message}
				/>
			)}
		</div>
	);
}

export const projectDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects/$projectId',
	component: ProjectDetailRouteComponent,
});
