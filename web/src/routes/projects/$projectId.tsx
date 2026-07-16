import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import {
	ChevronLeft,
	ChevronRight,
	Cpu,
	GitMerge,
	KeyRound,
	Play,
	Settings,
	SquareKanban,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { CredentialsPanel } from '@/components/projects/credentials-panel.js';
import { GitHubProjectsMappingForm } from '@/components/projects/github-projects-mapping-form.js';
import { ProjectRunsPanel } from '@/components/runs/project-runs-panel.js';
import {
	type BoardMappingForm,
	buildGithubProjectsUpdate,
	isBoardMappingDirty,
	toBoardMappingForm,
} from '@/lib/board-mapping.js';
import {
	anyCustomPromptError,
	CUSTOM_PROMPT_MAX_LENGTH,
	customPromptError,
	isCustomPromptDirty,
	normalizeCustomPrompt,
} from '@/lib/phase-prompt.js';
import {
	buildPipelineAutoAdvanceUpdate,
	buildPipelineEnabledUpdate,
	isAutoAdvancePhase,
	isPipelineAutoAdvanceDirty,
	isPipelineEnabledDirty,
	isRespondToReviewLocked,
	PIPELINE_TOGGLE_PHASES,
	type PipelineAutoAdvanceForm,
	type PipelineAutoAdvancePhase,
	type PipelineEnabledForm,
	type PipelineTogglePhase,
	setAutoAdvanceEnabled,
	setPhaseEnabled,
	toPipelineAutoAdvanceForm,
	toPipelineEnabledForm,
} from '@/lib/pipeline-enabled.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import type { AgentConfig, AgentsConfig, PipelineConfig } from '../../../../src/config/schema.js';
import type { AgentCli } from '../../../../src/harness/agent-cli.js';
import {
	AGENT_MODELS,
	capabilityFor,
	MODEL_CAPABILITIES,
	normalizeModelSelection,
	type ReasoningLevel,
	reasoningChoicesFor,
} from '../../../../src/harness/models.js';
import type { GitHubProjectsIntegrationConfig } from '../../../../src/integrations/pm/github-projects/config-schema.js';
import type { PmStatusKey } from '../../../../src/pm/pipeline.js';
import { rootRoute } from '../__root.js';

const PHASES = [
	'implementationUnplanned',
	'planning',
	'implementation',
	'review',
	'respondToReview',
	'respondToCi',
	'resolveConflicts',
] as const;

const DEFAULT_TIMEOUT_MINUTES = 30;

/** Phases that expose an enable/disable toggle (the optional, SCM-driven ones). */
const TOGGLEABLE_PHASES = new Set<string>(PIPELINE_TOGGLE_PHASES);

const PHASE_LABELS: Record<(typeof PHASES)[number], { label: string; code: string }> = {
	implementationUnplanned: {
		label: 'Implementation (unplanned)',
		code: 'implementationUnplanned',
	},
	planning: { label: 'Planning', code: 'planning' },
	implementation: { label: 'Implementation', code: 'implementation' },
	review: { label: 'Review', code: 'review' },
	respondToReview: { label: 'Respond to Review', code: 'respondToReview' },
	respondToCi: { label: 'Respond to CI', code: 'respondToCi' },
	resolveConflicts: { label: 'Resolve Conflicts', code: 'resolveConflicts' },
};

/**
 * Optional one-line explanation shown under a phase's detail heading. Most phases
 * need none; `implementationUnplanned` is a dispatch-time variant, so it clarifies
 * when its config actually applies.
 */
const PHASE_DESCRIPTIONS: Partial<Record<(typeof PHASES)[number], string>> = {
	implementationUnplanned:
		'Used only when Implementation was not preceded by a Planning run for this item; otherwise the Implementation configuration applies.',
};

/**
 * CLIs that can host a curated delegation *child* (`DELEGATION_CHILD_CAPABLE` in
 * `src/delegation/native.ts`), with the coded default light model each falls back
 * to (`DEFAULT_LIGHT_MODEL`). Antigravity is omitted — it can't host a child yet
 * (#185). The defaults are mirrored here for display only; the server resolves the
 * effective value.
 */
const LIGHT_MODEL_CLIS = [
	{ cli: 'claude', label: 'Claude', defaultModel: 'haiku' },
	{ cli: 'codex', label: 'Codex', defaultModel: 'gpt-5.4-mini' },
] as const;

const CODED_DEFAULT_MODEL: Record<string, string> = {
	claude: 'sonnet',
	codex: 'gpt-5.6-terra',
	antigravity: 'gemini-3.5-flash',
};

/** The user-facing label for a model id (its capability label, or the id itself). */
function modelLabel(cli: AgentCli, model: string): string {
	return capabilityFor(cli, model)?.label ?? model;
}

function getModelDefaultLabel(
	cli: AgentCli,
	projectDefaults?: Record<string, string | undefined>,
): string {
	const defaultModel = projectDefaults?.[cli] || CODED_DEFAULT_MODEL[cli] || 'Unset';
	return `Default (${modelLabel(cli, defaultModel)})`;
}

/**
 * The "Default" reasoning option label for a (cli, model) — surfaces the model's
 * known default so an omitted reasoning reads as e.g. "Default (Medium)" rather
 * than implying no reasoning happens (issue #180). `Default (unknown)` when the
 * CLI controls its own default (claude) or none is known.
 */
function getReasoningDefaultLabel(cli: AgentCli, model?: string): string {
	const def = model ? capabilityFor(cli, model)?.defaultReasoning : null;
	return def ? `Default (${capitalize(def)})` : 'Default (unknown)';
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The placeholder shown in a phase's Reasoning selector: "—" with no model, the
 * model's default level when it exposes a choice, else "Fixed" (a single-variant
 * model) or "N/A" (no reasoning knob at all). Extracted so the detail component's
 * cognitive complexity stays within budget.
 */
function reasoningPlaceholderLabel(
	cli: AgentCli | undefined,
	model: string | undefined,
	optionCount: number,
): string {
	if (!cli || !model) return '—';
	if (optionCount > 0) return getReasoningDefaultLabel(cli, model);
	return capabilityFor(cli, model)?.fixedVariant ? 'Fixed' : 'N/A';
}

/**
 * Derive the dependent CLI/Model/Reasoning/Timeout selector state for a phase's
 * config — the Model list depends on the CLI, the Reasoning list on the model.
 * Pulled out of {@link PhaseSettingsDetail} to keep its cognitive complexity
 * within budget.
 */
function phaseFieldState(config: AgentConfig, isPending: boolean) {
	const selectedCli = config.cli;
	const selectedModel = config.model;
	const reasoningOptions =
		selectedCli && selectedModel ? reasoningChoicesFor(selectedCli, selectedModel) : [];
	return {
		selectedCli,
		selectedModel,
		selectedReasoning: config.reasoning,
		timeoutMinutes:
			config.timeoutMs != null ? config.timeoutMs / (60 * 1000) : DEFAULT_TIMEOUT_MINUTES,
		modelOptions: selectedCli ? MODEL_CAPABILITIES[selectedCli] : [],
		reasoningOptions,
		reasoningDisabled: isPending || !selectedModel || reasoningOptions.length === 0,
		reasoningPlaceholder: reasoningPlaceholderLabel(
			selectedCli,
			selectedModel,
			reasoningOptions.length,
		),
	};
}

/**
 * Normalize a stored per-phase config for display: a legacy combined antigravity
 * model string (`"Gemini 3.5 Flash (High)"`) becomes its logical id + reasoning
 * so the Model and Reasoning selectors render the right selections. Non-legacy
 * values pass through untouched.
 */
function normalizeAgentsForDisplay(agents: AgentsConfig): AgentsConfig {
	const next: AgentsConfig = { ...agents };
	for (const phase of PHASES) {
		const config = agents[phase];
		if (!config?.cli || !config.model) continue;
		const { model, reasoning } = normalizeModelSelection(config.cli, config.model);
		if (model !== config.model) {
			next[phase] = { ...config, model, reasoning: config.reasoning ?? reasoning };
		}
	}
	return next;
}

function isPhaseConfigDirty(local: AgentConfig = {}, db: AgentConfig = {}): boolean {
	const normalizedDb = db.cli && db.model ? normalizeModelSelection(db.cli, db.model) : undefined;
	const dbModel = normalizedDb?.model ?? db.model;
	const dbReasoning = db.reasoning ?? normalizedDb?.reasoning;
	return (
		(local.cli ?? '') !== (db.cli ?? '') ||
		(local.model ?? '') !== (dbModel ?? '') ||
		(local.reasoning ?? '') !== (dbReasoning ?? '') ||
		(local.timeoutMs ?? '') !== (db.timeoutMs ?? '') ||
		isCustomPromptDirty(local.prompt, db.prompt)
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
	// Preserve the delegation policy verbatim — the dashboard only edits its
	// `lightModels`, but `enabled`/`phases`/`minimumSemanticOperations` may be set
	// in swarm.config.json and must survive an agents-tab save unchanged.
	if (agents.delegation) cleanAgents.delegation = agents.delegation;
	return Object.keys(cleanAgents).length > 0 ? cleanAgents : undefined;
}

function cleanAgentConfig({
	cli,
	model,
	reasoning,
	timeoutMs,
	prompt,
}: AgentConfig): AgentConfig | undefined {
	// Whitespace-only prompt is not a meaningful override (issue #135) — drop it so
	// it's neither persisted nor counted as a set value here.
	const normalizedPrompt = normalizeCustomPrompt(prompt);
	if (!cli && !model && !reasoning && !timeoutMs && !normalizedPrompt) return undefined;
	// Reasoning is meaningless without a model to validate it against — drop it if
	// the model was cleared, so a stale level can't reach the server.
	return {
		cli,
		model,
		reasoning: model ? reasoning : undefined,
		timeoutMs,
		prompt: normalizedPrompt,
	};
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

/** Shared select/input recipe (ai/DESIGN_SYSTEM.md §4), factored to a const. */
const FIELD_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500 transition-shadow';

/** Shared field label recipe (ai/DESIGN_SYSTEM.md §4). */
const LABEL_CLASS = 'block text-xs font-medium text-zinc-400 mb-1.5';

/** Card wrapper recipe shared by the phase-detail sections. */
const CARD_CLASS = 'border border-zinc-800 rounded-lg bg-[#0F0F11]/40 p-6 shadow-sm';

/** Display labels for the agent CLIs, used in the phase-row summary. */
const CLI_LABELS: Record<AgentCli, string> = {
	claude: 'Claude',
	antigravity: 'Antigravity',
	codex: 'Codex',
};

/**
 * A one-line summary of a phase's current CLI/model/reasoning/timeout override
 * for the navigation row — "Coded defaults" when nothing is set, else the set
 * values joined (e.g. "Claude · Sonnet · High · 30m"). The custom prompt is
 * surfaced separately as a badge, not folded into this string.
 */
function phaseConfigSummary(config: AgentConfig): string {
	const parts: string[] = [];
	if (config.cli) {
		parts.push(CLI_LABELS[config.cli]);
		if (config.model) parts.push(modelLabel(config.cli, config.model));
		if (config.reasoning) parts.push(capitalize(config.reasoning));
	}
	if (config.timeoutMs != null) parts.push(`${config.timeoutMs / (60 * 1000)}m`);
	return parts.length > 0 ? parts.join(' · ') : 'Coded defaults';
}

interface PhaseConfigRowProps {
	phase: (typeof PHASES)[number];
	config: AgentConfig;
	isPending: boolean;
	/** Enabled state for the optional phases; `undefined` for mandatory rows. */
	enabled?: boolean;
	/** Whether the enable toggle is locked off by a dependency (Review → Respond). */
	enabledDisabled?: boolean;
	handleEnabledChange?: (phase: PipelineTogglePhase, enabled: boolean) => void;
	autoAdvance?: boolean;
	handleAutoAdvanceChange?: (phase: PipelineAutoAdvancePhase, enabled: boolean) => void;
	/** Open the phase-detail screen for this row. */
	onSelect: (phase: (typeof PHASES)[number]) => void;
}

/**
 * The Enabled-column cell for one phase: a toggle switch for the optional,
 * SCM-driven phases, or a static "Always on" label for the mandatory ones
 * (Planning, Implementation, Resolve Conflicts, signalled by
 * `enabled === undefined`). Split out of {@link PhaseConfigRow} so that row's
 * dependent-selector logic stays the dominant thing it reads as.
 */
export function PhaseEnabledCell({
	phase,
	label,
	enabled,
	enabledDisabled,
	isPending,
	handleEnabledChange,
}: {
	phase: (typeof PHASES)[number];
	label: string;
	enabled?: boolean;
	enabledDisabled?: boolean;
	isPending: boolean;
	handleEnabledChange?: (phase: PipelineTogglePhase, enabled: boolean) => void;
}) {
	if (enabled === undefined) {
		return <span className="text-xs text-zinc-500">Always on</span>;
	}
	return (
		<PhaseToggleSwitch
			checked={enabled === true}
			label={`${label} enabled`}
			disabled={Boolean(isPending || enabledDisabled)}
			onChange={() => handleEnabledChange?.(phase as PipelineTogglePhase, !enabled)}
		/>
	);
}

/** A compact design-system switch shared by the phase controls. */
export function PhaseToggleSwitch({
	checked,
	label,
	disabled,
	onChange,
}: {
	checked: boolean;
	label: string;
	disabled: boolean;
	onChange?: () => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			// The row navigates on click; keep the toggle from bubbling up to it
			// (ai/DESIGN_SYSTEM.md: trailing row action calls stopPropagation).
			onClick={(e) => {
				e.stopPropagation();
				onChange?.();
			}}
			className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-1 focus:ring-offset-[#0F0F11] disabled:opacity-50 disabled:cursor-not-allowed ${checked ? 'bg-violet-600' : 'bg-zinc-700'}`}
		>
			<span
				className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`}
			/>
		</button>
	);
}

/**
 * One phase's navigation row in the Agent Configuration summary: phase identity,
 * its Enabled toggle (optional phases only), a one-line summary of the current
 * override, a "Custom prompt" badge when one is set, and a trailing chevron. The
 * whole row is clickable and keyboard-focusable and opens the phase-detail screen
 * (ai/DESIGN_SYSTEM.md blesses whole-row-click navigation as long as the trailing
 * per-row action — here the Enabled switch — stops propagation).
 */
export function PhaseConfigRow({
	phase,
	config,
	isPending,
	enabled,
	enabledDisabled,
	handleEnabledChange,
	autoAdvance,
	handleAutoAdvanceChange,
	onSelect,
}: PhaseConfigRowProps) {
	const phaseLabel = PHASE_LABELS[phase];
	const hasCustomPrompt = normalizeCustomPrompt(config.prompt) !== undefined;
	return (
		// Mouse users can click anywhere on the row; keyboard/AT users reach the
		// explicit button in the trailing cell (which is what actually carries the
		// accessible name and focus — a role="button" <tr> trips Biome a11y and is
		// worse for AT than a real control).
		<tr
			onClick={() => onSelect(phase)}
			className="hover:bg-zinc-800/40 focus-within:bg-zinc-800/40 cursor-pointer transition-colors"
		>
			<td className="px-4 py-3.5">
				<div className="text-sm font-medium text-zinc-200">{phaseLabel.label}</div>
				<div className="text-xs text-zinc-500 font-mono select-all">{phaseLabel.code}</div>
			</td>
			<td className="px-4 py-3.5">
				<PhaseEnabledCell
					phase={phase}
					label={phaseLabel.label}
					enabled={enabled}
					enabledDisabled={enabledDisabled}
					isPending={isPending}
					handleEnabledChange={handleEnabledChange}
				/>
			</td>
			<td className="px-4 py-3.5">
				{autoAdvance === undefined ? (
					<span className="text-xs text-zinc-500">N/A</span>
				) : (
					<PhaseToggleSwitch
						checked={autoAdvance}
						label={`${phaseLabel.label} auto-advance`}
						disabled={isPending}
						onChange={() =>
							handleAutoAdvanceChange?.(phase as PipelineAutoAdvancePhase, !autoAdvance)
						}
					/>
				)}
			</td>
			<td className="px-4 py-3.5">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm text-zinc-300">{phaseConfigSummary(config)}</span>
					{hasCustomPrompt && (
						<span className="px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-300 bg-violet-950/40 border border-violet-900/40 rounded">
							Custom prompt
						</span>
					)}
				</div>
			</td>
			<td className="px-4 py-3.5 text-right">
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onSelect(phase);
					}}
					aria-label={`Configure ${phaseLabel.label} phase`}
					className="inline-flex items-center justify-center rounded p-1 text-zinc-500 hover:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors"
				>
					<ChevronRight className="h-4 w-4" aria-hidden="true" />
				</button>
			</td>
		</tr>
	);
}

interface PhaseSettingsDetailProps {
	phase: (typeof PHASES)[number];
	config: AgentConfig;
	projectDefaults?: AgentsConfig['defaults'];
	isPending: boolean;
	enabled?: boolean;
	enabledDisabled?: boolean;
	handleEnabledChange?: (phase: PipelineTogglePhase, enabled: boolean) => void;
	autoAdvance?: boolean;
	handleAutoAdvanceChange?: (phase: PipelineAutoAdvancePhase, enabled: boolean) => void;
	handleCliChange: (phase: keyof AgentsConfig, value: string) => void;
	handleModelChange: (phase: keyof AgentsConfig, value: string) => void;
	handleReasoningChange: (phase: keyof AgentsConfig, value: string) => void;
	handleTimeoutChange: (phase: keyof AgentsConfig, value: string) => void;
	handlePromptChange: (phase: keyof AgentsConfig, value: string) => void;
	onBack: () => void;
}

/**
 * Renders a phase's optional explanatory note (from {@link PHASE_DESCRIPTIONS}),
 * or nothing when the phase has none. Kept out of {@link PhaseSettingsDetail} so
 * that component's cognitive complexity stays within budget.
 */
function PhaseDetailNote({ phase }: { phase: (typeof PHASES)[number] }) {
	const description = PHASE_DESCRIPTIONS[phase];
	if (!description) return null;
	return <p className="text-xs text-zinc-400">{description}</p>;
}

/**
 * The per-phase detail screen: the CLI/Model/Reasoning/Timeout selectors that
 * used to live inline in the summary row, plus a read-only summary of the phase's
 * fixed SWARM system prompt and the editable, optional Custom prompt (issue
 * #135). It shares the route's `agents` state and the single Save/Reset model
 * (rendered by {@link AgentConfigurationForm}) — nothing here saves on its own.
 */
export function PhaseSettingsDetail({
	phase,
	config,
	projectDefaults,
	isPending,
	enabled,
	enabledDisabled,
	handleEnabledChange,
	autoAdvance,
	handleAutoAdvanceChange,
	handleCliChange,
	handleModelChange,
	handleReasoningChange,
	handleTimeoutChange,
	handlePromptChange,
	onBack,
}: PhaseSettingsDetailProps) {
	const phaseLabel = PHASE_LABELS[phase];
	const {
		selectedCli,
		selectedModel,
		selectedReasoning,
		timeoutMinutes,
		modelOptions,
		reasoningOptions,
		reasoningDisabled,
		reasoningPlaceholder,
	} = phaseFieldState(config, isPending);

	const promptValue = config.prompt ?? '';
	const promptErr = customPromptError(promptValue);
	const promptLength = (normalizeCustomPrompt(promptValue) ?? '').length;

	return (
		<div className="space-y-6">
			<button
				type="button"
				onClick={onBack}
				className="inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
			>
				<ChevronLeft className="h-4 w-4" aria-hidden="true" />
				Back to Agent Configuration
			</button>

			<div className={`${CARD_CLASS} space-y-5`}>
				<div>
					<h2 className="text-sm font-semibold text-zinc-200">{phaseLabel.label}</h2>
					<div className="text-xs text-zinc-500 font-mono select-all">{phaseLabel.code}</div>
				</div>

				<PhaseDetailNote phase={phase} />

				<div className="space-y-4 p-4 border border-zinc-800 rounded-md bg-[#0F0F11]/20">
					<div className="flex items-start gap-3">
						{enabled === undefined ? (
							<PhaseToggleSwitch
								checked={true}
								label={`${phaseLabel.label} enabled (always on)`}
								disabled={true}
							/>
						) : (
							<PhaseEnabledCell
								phase={phase}
								label={phaseLabel.label}
								enabled={enabled}
								enabledDisabled={enabledDisabled}
								isPending={isPending}
								handleEnabledChange={handleEnabledChange}
							/>
						)}
						<span>
							<span className="block text-sm font-medium text-zinc-200">Enabled</span>
							{enabled === undefined ? (
								<span className="block text-xs text-zinc-400 mt-1">Always on</span>
							) : enabledDisabled ? (
								<span className="block text-xs text-zinc-400 mt-1">
									Locked off while Review is disabled.
								</span>
							) : null}
						</span>
					</div>

					{autoAdvance !== undefined && (
						<div className="flex items-start gap-3">
							<PhaseToggleSwitch
								checked={autoAdvance}
								label={`${phaseLabel.label} auto-advance`}
								disabled={isPending}
								onChange={() =>
									handleAutoAdvanceChange?.(phase as PipelineAutoAdvancePhase, !autoAdvance)
								}
							/>
							<span>
								<span className="block text-sm font-medium text-zinc-200">Auto-advance</span>
								<span className="block text-xs text-zinc-400 mt-1">
									{phase === 'planning'
										? 'Move to ToDo after SWARM posts the plan.'
										: 'Move to In review after SWARM opens the pull request.'}
								</span>
							</span>
						</div>
					)}
				</div>

				<div className="grid gap-5 sm:grid-cols-2">
					<div>
						<label htmlFor={`${phase}-cli`} className={LABEL_CLASS}>
							Agent CLI
						</label>
						<select
							id={`${phase}-cli`}
							value={selectedCli ?? ''}
							onChange={(e) => handleCliChange(phase, e.target.value)}
							disabled={isPending}
							className={FIELD_CLASS}
						>
							<option value="">Default (Unset)</option>
							<option value="claude">Claude</option>
							<option value="antigravity">Antigravity</option>
							<option value="codex">Codex</option>
						</select>
					</div>
					<div>
						<label htmlFor={`${phase}-model`} className={LABEL_CLASS}>
							Model
						</label>
						<select
							id={`${phase}-model`}
							value={selectedModel ?? ''}
							onChange={(e) => handleModelChange(phase, e.target.value)}
							disabled={isPending || !selectedCli}
							className={`${FIELD_CLASS} font-mono`}
						>
							<option value="">
								{selectedCli
									? getModelDefaultLabel(selectedCli, projectDefaults)
									: 'Default (Unset)'}
							</option>
							{modelOptions.map((model) => (
								<option key={model.id} value={model.id}>
									{model.label}
								</option>
							))}
						</select>
					</div>
					<div>
						<label htmlFor={`${phase}-reasoning`} className={LABEL_CLASS}>
							Reasoning
						</label>
						<select
							id={`${phase}-reasoning`}
							value={selectedReasoning ?? ''}
							onChange={(e) => handleReasoningChange(phase, e.target.value)}
							disabled={reasoningDisabled}
							className={FIELD_CLASS}
						>
							<option value="">{reasoningPlaceholder}</option>
							{reasoningOptions.map((level) => (
								<option key={level} value={level}>
									{capitalize(level)}
								</option>
							))}
						</select>
					</div>
					<div>
						<label htmlFor={`${phase}-timeout`} className={LABEL_CLASS}>
							Timeout (minutes)
						</label>
						<input
							id={`${phase}-timeout`}
							type="number"
							min="5"
							max="45"
							value={timeoutMinutes}
							onChange={(e) => handleTimeoutChange(phase, e.target.value)}
							disabled={isPending}
							className={`${FIELD_CLASS} font-mono`}
						/>
					</div>
				</div>
			</div>

			<div className={`${CARD_CLASS} space-y-2`}>
				<label htmlFor={`${phase}-prompt`} className="block text-sm font-semibold text-zinc-200">
					Custom prompt (optional)
				</label>
				<p className="text-xs text-zinc-400">
					Appended to SWARM's built-in phase instructions as an additional "Project instructions"
					section. It supplements — never overrides — them, and is empty by default; leave it blank
					to keep the default behavior.
				</p>
				<textarea
					id={`${phase}-prompt`}
					value={promptValue}
					onChange={(e) => handlePromptChange(phase, e.target.value)}
					disabled={isPending}
					rows={8}
					placeholder="e.g. Prefer our internal utility modules over adding new dependencies."
					aria-invalid={promptErr ? true : undefined}
					className={`${FIELD_CLASS} font-mono resize-y`}
				/>
				{promptErr ? (
					<p className="text-xs text-red-400">{promptErr}</p>
				) : (
					<p className="text-xs text-zinc-500">
						{promptLength.toLocaleString()} / {CUSTOM_PROMPT_MAX_LENGTH.toLocaleString()} characters
					</p>
				)}
			</div>
		</div>
	);
}

interface AgentConfigurationFormProps {
	agents: AgentsConfig;
	pipelineEnabled: PipelineEnabledForm;
	pipelineAutoAdvance: PipelineAutoAdvanceForm;
	/** The phase whose detail screen is open, or `null` for the summary table. */
	selectedPhase: (typeof PHASES)[number] | null;
	onSelectPhase: (phase: (typeof PHASES)[number]) => void;
	onBack: () => void;
	handleEnabledChange: (phase: PipelineTogglePhase, enabled: boolean) => void;
	handleAutoAdvanceChange: (phase: PipelineAutoAdvancePhase, enabled: boolean) => void;
	handleCliChange: (phase: keyof AgentsConfig, value: string) => void;
	handleModelChange: (phase: keyof AgentsConfig, value: string) => void;
	handleReasoningChange: (phase: keyof AgentsConfig, value: string) => void;
	handleTimeoutChange: (phase: keyof AgentsConfig, value: string) => void;
	handlePromptChange: (phase: keyof AgentsConfig, value: string) => void;
	handleLightModelChange: (cli: 'claude' | 'codex', value: string) => void;
	handleSubmit: (e: React.FormEvent) => void;
	handleReset: () => void;
	isDirty: boolean;
	/** True when any phase's custom prompt is over the bound — blocks Save. */
	hasPromptError: boolean;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
	errorMessage?: string;
}

/**
 * Agent Configuration tab. Shows the per-phase summary table (each row navigates
 * to its detail screen) plus the global Light Models table, or — when a phase is
 * selected — that phase's detail screen. Both views live in one `<form>` and
 * share a single Save/Reset and the route's `agents`/`pipeline` state, so there
 * is no second competing save model (issue #135, #119).
 */
function AgentConfigurationForm({
	agents,
	pipelineEnabled,
	pipelineAutoAdvance,
	selectedPhase,
	onSelectPhase,
	onBack,
	handleEnabledChange,
	handleAutoAdvanceChange,
	handleCliChange,
	handleModelChange,
	handleReasoningChange,
	handleTimeoutChange,
	handlePromptChange,
	handleLightModelChange,
	handleSubmit,
	handleReset,
	isDirty,
	hasPromptError,
	isPending,
	isSuccess,
	isError,
	errorMessage,
}: AgentConfigurationFormProps) {
	return (
		<form onSubmit={handleSubmit} className="space-y-6">
			{selectedPhase ? (
				<PhaseSettingsDetail
					phase={selectedPhase}
					config={agents[selectedPhase] ?? {}}
					projectDefaults={agents.defaults}
					isPending={isPending}
					enabled={
						TOGGLEABLE_PHASES.has(selectedPhase)
							? pipelineEnabled[selectedPhase as PipelineTogglePhase]
							: undefined
					}
					enabledDisabled={
						selectedPhase === 'respondToReview' && isRespondToReviewLocked(pipelineEnabled)
					}
					autoAdvance={
						selectedPhase && isAutoAdvancePhase(selectedPhase)
							? pipelineAutoAdvance[selectedPhase]
							: undefined
					}
					handleEnabledChange={handleEnabledChange}
					handleAutoAdvanceChange={handleAutoAdvanceChange}
					handleCliChange={handleCliChange}
					handleModelChange={handleModelChange}
					handleReasoningChange={handleReasoningChange}
					handleTimeoutChange={handleTimeoutChange}
					handlePromptChange={handlePromptChange}
					onBack={onBack}
				/>
			) : (
				<>
					<div className="border border-zinc-800 rounded-lg bg-[#0F0F11]/40 p-6 shadow-sm">
						<div>
							<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
								Phases Configuration
							</h2>
							<p className="text-xs text-zinc-400 mb-4">
								Select a phase to configure its agent CLI, model, and an optional custom prompt.
								Unset values fall back to the pipeline's coded defaults.
							</p>

							<div className="border border-zinc-800 rounded-md overflow-hidden bg-[#0F0F11]/20 shadow-sm">
								<table className="w-full text-left border-collapse">
									<thead>
										<tr className="bg-zinc-800/30 border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-400 font-semibold">
											<th className="px-4 py-3">Phase</th>
											<th className="px-4 py-3">Enabled</th>
											<th className="px-4 py-3">Auto-advance</th>
											<th className="px-4 py-3">Configuration</th>
											<th className="px-4 py-3">
												<span className="sr-only">Open</span>
											</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-zinc-800/60">
										{PHASES.map((phase) => (
											<PhaseConfigRow
												key={phase}
												phase={phase}
												config={agents[phase] ?? {}}
												isPending={isPending}
												enabled={
													TOGGLEABLE_PHASES.has(phase)
														? pipelineEnabled[phase as PipelineTogglePhase]
														: undefined
												}
												enabledDisabled={
													phase === 'respondToReview' && isRespondToReviewLocked(pipelineEnabled)
												}
												autoAdvance={
													isAutoAdvancePhase(phase) ? pipelineAutoAdvance[phase] : undefined
												}
												handleEnabledChange={handleEnabledChange}
												handleAutoAdvanceChange={handleAutoAdvanceChange}
												onSelect={onSelectPhase}
											/>
										))}
									</tbody>
								</table>
							</div>
						</div>
					</div>

					<div className="border border-zinc-800 rounded-lg bg-[#0F0F11]/40 p-6 shadow-sm">
						<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
							Light Models
						</h2>
						<p className="text-xs text-zinc-400 mb-4">
							The lighter model each CLI uses for bounded curated delegation (the
							<code className="mx-1 text-zinc-300">swarm delegate</code> child run). Applies only
							when delegation is enabled for a phase; leave unset to use the coded default.
							Antigravity cannot host a delegation child yet.
						</p>

						<div className="border border-zinc-800 rounded-md overflow-hidden bg-[#0F0F11]/20 shadow-sm">
							<table className="w-full text-left border-collapse">
								<thead>
									<tr className="bg-zinc-800/30 border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-400 font-semibold">
										<th className="px-4 py-3">Agent CLI</th>
										<th className="px-4 py-3">Light Model</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-zinc-800/60">
									{LIGHT_MODEL_CLIS.map(({ cli, label, defaultModel }) => {
										const selected = agents.delegation?.lightModels?.[cli];
										return (
											<tr key={cli} className="hover:bg-zinc-800/40 transition-colors">
												<td className="px-4 py-3.5">
													<div className="text-sm font-medium text-zinc-200">{label}</div>
													<div className="text-xs text-zinc-500 font-mono select-all">{cli}</div>
												</td>
												<td className="px-4 py-3.5">
													<select
														value={selected ?? ''}
														onChange={(e) => handleLightModelChange(cli, e.target.value)}
														disabled={isPending}
														aria-label={`${label} light model`}
														className="block w-full max-w-[300px] px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500 font-mono transition-shadow"
													>
														<option value="">Default ({defaultModel})</option>
														{AGENT_MODELS[cli].map((model) => (
															<option key={model} value={model}>
																{model}
															</option>
														))}
													</select>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					</div>
				</>
			)}

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
					disabled={isPending || !isDirty || hasPromptError}
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
	);
}

interface PipelineSettingsFormProps {
	autoMerge: boolean;
	setAutoMerge: (value: boolean) => void;
	skipRespondToReviewOnMinors: boolean;
	setSkipRespondToReviewOnMinors: (value: boolean) => void;
	handleSubmit: (e: React.FormEvent) => void;
	handleReset: () => void;
	isDirty: boolean;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
	errorMessage?: string;
}

function PipelineSettingsForm({
	autoMerge,
	setAutoMerge,
	skipRespondToReviewOnMinors,
	setSkipRespondToReviewOnMinors,
	handleSubmit,
	handleReset,
	isDirty,
	isPending,
	isSuccess,
	isError,
	errorMessage,
}: PipelineSettingsFormProps) {
	return (
		<div className="border border-zinc-800 rounded-lg bg-[#0F0F11]/40 p-6 shadow-sm">
			<form onSubmit={handleSubmit} className="space-y-6">
				<div>
					<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
						Pipeline Automation
					</h2>
					<label className="flex items-start gap-3 p-4 border border-zinc-800 rounded-md bg-[#0F0F11]/20 cursor-pointer hover:bg-zinc-800/20 transition-colors">
						<input
							type="checkbox"
							checked={autoMerge}
							onChange={(event) => setAutoMerge(event.target.checked)}
							disabled={isPending}
							className="mt-0.5 h-4 w-4 accent-violet-600 disabled:opacity-50"
						/>
						<span>
							<span className="block text-sm font-medium text-zinc-200">Auto merge</span>
							<span className="block text-xs text-zinc-400 mt-1">
								After SWARM responds to a reviewer, merge the pull request when GitHub reports it is
								eligible. Required checks and repository rules still apply.
							</span>
						</span>
					</label>
					<label className="flex items-start gap-3 p-4 border border-zinc-800 rounded-md bg-[#0F0F11]/20 cursor-pointer hover:bg-zinc-800/20 transition-colors">
						<input
							type="checkbox"
							checked={skipRespondToReviewOnMinors}
							onChange={(event) => setSkipRespondToReviewOnMinors(event.target.checked)}
							disabled={isPending}
							className="mt-0.5 h-4 w-4 accent-violet-600 disabled:opacity-50"
						/>
						<span>
							<span className="block text-sm font-medium text-zinc-200">
								Skip respond to review on minors
							</span>
							<span className="block text-xs text-zinc-400 mt-1">
								Only start Respond to Review for a reviewer request-changes verdict. Approvals and
								comment-only reviews do not consume a separate agent run.
							</span>
						</span>
					</label>
				</div>

				{isSuccess && (
					<div className="p-3 bg-emerald-950/20 border border-emerald-900/30 text-sm text-emerald-400 rounded">
						Pipeline settings saved successfully.
					</div>
				)}
				{isError && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						Failed to save pipeline settings: {errorMessage}
					</div>
				)}

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

	const [activeTab, setActiveTab] = useState<
		'general' | 'agents' | 'pipeline' | 'runs' | 'boardMapping' | 'credentials'
	>('runs');
	const [agents, setAgents] = useState<AgentsConfig>({});
	// Which phase's detail screen is open in the Agent Configuration tab, or null
	// for the summary table (issue #135). Purely view state — the edits themselves
	// live in `agents` and save through the one shared mutation.
	const [selectedPhase, setSelectedPhase] = useState<(typeof PHASES)[number] | null>(null);
	const [pipelineEnabled, setPipelineEnabled] = useState<PipelineEnabledForm>(() =>
		toPipelineEnabledForm(undefined),
	);
	const [pipelineAutoAdvance, setPipelineAutoAdvance] = useState<PipelineAutoAdvanceForm>(() =>
		toPipelineAutoAdvanceForm(undefined),
	);
	const [autoMerge, setAutoMerge] = useState(false);
	const [skipRespondToReviewOnMinors, setSkipRespondToReviewOnMinors] = useState(true);
	const [boardMapping, setBoardMapping] = useState<BoardMappingForm>(() =>
		toBoardMappingForm(undefined),
	);

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
			setAgents(normalizeAgentsForDisplay(project.agents ?? {}));
			setPipelineEnabled(toPipelineEnabledForm(project.pipeline));
			setPipelineAutoAdvance(toPipelineAutoAdvanceForm(project.pipeline));
			setAutoMerge(project.pipeline?.respondToReview?.autoMerge ?? false);
			setSkipRespondToReviewOnMinors(project.pipeline?.respondToReview?.skipOnMinors ?? true);
			setBoardMapping(toBoardMappingForm(project.githubProjects));
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
			pipeline?: PipelineConfig;
			githubProjects?: GitHubProjectsIntegrationConfig;
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

		const localLight = agents.delegation?.lightModels ?? {};
		const dbLight = projectAgents.delegation?.lightModels ?? {};
		const hasLightChange = (['claude', 'codex'] as const).some(
			(cli) => (localLight[cli] ?? '') !== (dbLight[cli] ?? ''),
		);
		if (hasLightChange) return true;

		if (PHASES.some((phase) => isPhaseConfigDirty(agents[phase], projectAgents[phase])))
			return true;

		// The per-phase enable toggles save through this same form.
		return (
			isPipelineEnabledDirty(pipelineEnabled, project.pipeline) ||
			isPipelineAutoAdvanceDirty(pipelineAutoAdvance, project.pipeline)
		);
	}, [project, agents, pipelineEnabled, pipelineAutoAdvance]);

	// An over-limit custom prompt on any phase would only fail server-side; surface
	// it client-side so Save is blocked and the field error is the sole feedback.
	const hasAgentPromptError = useMemo(
		() => anyCustomPromptError(PHASES.map((phase) => agents[phase]?.prompt)),
		[agents],
	);

	const isPipelineDirty = useMemo(
		() =>
			autoMerge !== (project?.pipeline?.respondToReview?.autoMerge ?? false) ||
			skipRespondToReviewOnMinors !== (project?.pipeline?.respondToReview?.skipOnMinors ?? true),
		[project, autoMerge, skipRespondToReviewOnMinors],
	);

	const isBoardMappingFormDirty = useMemo(
		() => isBoardMappingDirty(boardMapping, project?.githubProjects),
		[boardMapping, project],
	);

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
			// Reasoning is model-specific: any CLI change may make the old level invalid,
			// so clear it rather than keep a hidden incompatible value (issue #180).
			updatedPhase.reasoning = undefined;
			return {
				...prev,
				[phase]: updatedPhase,
			};
		});
		updateMutation.reset();
	};

	const handleModelChange = (phase: keyof AgentsConfig, value: string) => {
		setAgents((prev) => {
			const current = (prev[phase] ?? {}) as AgentConfig;
			const model = value || undefined;
			// Keep the reasoning only if the newly selected model still supports it.
			const stillValid =
				current.reasoning &&
				current.cli &&
				model &&
				(reasoningChoicesFor(current.cli, model) as readonly string[]).includes(current.reasoning);
			return {
				...prev,
				[phase]: {
					...current,
					model,
					reasoning: stillValid ? current.reasoning : undefined,
				},
			};
		});
		updateMutation.reset();
	};

	const handleReasoningChange = (phase: keyof AgentsConfig, value: string) => {
		setAgents((prev) => ({
			...prev,
			[phase]: {
				...prev[phase],
				reasoning: value ? (value as ReasoningLevel) : undefined,
			},
		}));
		updateMutation.reset();
	};

	const handleTimeoutChange = (phase: keyof AgentsConfig, value: string) => {
		// The field edits whole minutes; the config stores milliseconds.
		setAgents((prev) => ({
			...prev,
			[phase]: { ...prev[phase], timeoutMs: Number(value) * 60 * 1000 },
		}));
		updateMutation.reset();
	};

	const handlePromptChange = (phase: keyof AgentsConfig, value: string) => {
		// Store the raw textarea value while editing; it's trimmed/dropped-if-blank
		// on save and in the dirty check (issue #135).
		setAgents((prev) => ({
			...prev,
			[phase]: { ...prev[phase], prompt: value },
		}));
		updateMutation.reset();
	};

	const handleLightModelChange = (cli: 'claude' | 'codex', value: string) => {
		setAgents((prev) => {
			// Preserve the rest of the delegation policy; only touch lightModels. When
			// no delegation block exists yet, create a disabled one to hold the pin.
			const delegation = prev.delegation ?? {
				enabled: false,
				minimumSemanticOperations: 3,
				phases: {},
			};
			const lightModels = { ...(delegation.lightModels ?? {}) };
			if (value) lightModels[cli] = value;
			else delete lightModels[cli];
			return {
				...prev,
				delegation: {
					...delegation,
					lightModels: Object.keys(lightModels).length > 0 ? lightModels : undefined,
				},
			};
		});
		updateMutation.reset();
	};

	const handleEnabledChange = (phase: PipelineTogglePhase, enabled: boolean) => {
		setPipelineEnabled((prev) => setPhaseEnabled(prev, phase, enabled));
		updateMutation.reset();
	};

	const handleAutoAdvanceChange = (phase: PipelineAutoAdvancePhase, enabled: boolean) => {
		setPipelineAutoAdvance((prev) => setAutoAdvanceEnabled(prev, phase, enabled));
		updateMutation.reset();
	};

	const handleAgentsReset = () => {
		if (project) {
			setAgents(normalizeAgentsForDisplay(project.agents ?? {}));
			setPipelineEnabled(toPipelineEnabledForm(project.pipeline));
			setPipelineAutoAdvance(toPipelineAutoAdvanceForm(project.pipeline));
			updateMutation.reset();
		}
	};

	const handleAgentsSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		// Save is disabled while a prompt is over-limit, but guard here too so an
		// Enter-to-submit from a field can't bypass the client-side bound (issue #135).
		if (hasAgentPromptError) return;
		const finalAgents = cleanAgentsConfig(agents);
		updateMutation.mutate({
			id: projectId,
			agents: finalAgents,
			pipeline: buildPipelineAutoAdvanceUpdate(
				pipelineAutoAdvance,
				buildPipelineEnabledUpdate(pipelineEnabled, project?.pipeline),
			),
		});
	};

	const handlePipelineSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		updateMutation.mutate({
			id: projectId,
			pipeline: {
				...project?.pipeline,
				respondToReview: {
					...project?.pipeline?.respondToReview,
					autoMerge,
					skipOnMinors: skipRespondToReviewOnMinors,
				},
			},
		});
	};

	const handlePipelineReset = () => {
		setAutoMerge(project?.pipeline?.respondToReview?.autoMerge ?? false);
		setSkipRespondToReviewOnMinors(project?.pipeline?.respondToReview?.skipOnMinors ?? true);
		updateMutation.reset();
	};

	const handleBoardMappingProjectId = (value: string) => {
		setBoardMapping((prev) => ({ ...prev, projectId: value }));
		updateMutation.reset();
	};

	const handleBoardMappingStatusFieldId = (value: string) => {
		setBoardMapping((prev) => ({ ...prev, statusFieldId: value }));
		updateMutation.reset();
	};

	const handleBoardMappingStatusOption = (key: PmStatusKey, value: string) => {
		setBoardMapping((prev) => ({
			...prev,
			statusOptions: { ...prev.statusOptions, [key]: value },
		}));
		updateMutation.reset();
	};

	const handleBoardMappingReset = () => {
		setBoardMapping(toBoardMappingForm(project?.githubProjects));
		updateMutation.reset();
	};

	const handleBoardMappingSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		updateMutation.mutate({
			id: projectId,
			githubProjects: buildGithubProjectsUpdate(boardMapping, project?.githubProjects),
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
						setActiveTab('runs');
						updateMutation.reset();
					}}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all border-b-2 ${
						activeTab === 'runs'
							? 'border-violet-500 text-white bg-zinc-800/20'
							: 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<Play className="h-4 w-4 text-violet-400" />
					Runs
				</button>
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
					Settings
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
				<button
					type="button"
					onClick={() => {
						setActiveTab('pipeline');
						updateMutation.reset();
					}}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all border-b-2 ${
						activeTab === 'pipeline'
							? 'border-violet-500 text-white bg-zinc-800/20'
							: 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<GitMerge className="h-4 w-4 text-violet-400" />
					Pipeline
				</button>
				<button
					type="button"
					onClick={() => {
						setActiveTab('boardMapping');
						updateMutation.reset();
					}}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all border-b-2 ${
						activeTab === 'boardMapping'
							? 'border-violet-500 text-white bg-zinc-800/20'
							: 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<SquareKanban className="h-4 w-4 text-violet-400" />
					Board Mapping
				</button>
				<button
					type="button"
					onClick={() => {
						setActiveTab('credentials');
						updateMutation.reset();
					}}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all border-b-2 ${
						activeTab === 'credentials'
							? 'border-violet-500 text-white bg-zinc-800/20'
							: 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<KeyRound className="h-4 w-4 text-violet-400" />
					Credentials
				</button>
			</div>

			{activeTab === 'runs' && <ProjectRunsPanel projectId={projectId} />}

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
					pipelineEnabled={pipelineEnabled}
					pipelineAutoAdvance={pipelineAutoAdvance}
					selectedPhase={selectedPhase}
					onSelectPhase={setSelectedPhase}
					onBack={() => setSelectedPhase(null)}
					handleEnabledChange={handleEnabledChange}
					handleAutoAdvanceChange={handleAutoAdvanceChange}
					handleCliChange={handleCliChange}
					handleModelChange={handleModelChange}
					handleReasoningChange={handleReasoningChange}
					handleTimeoutChange={handleTimeoutChange}
					handlePromptChange={handlePromptChange}
					handleLightModelChange={handleLightModelChange}
					handleSubmit={handleAgentsSubmit}
					handleReset={handleAgentsReset}
					isDirty={isAgentsDirty}
					hasPromptError={hasAgentPromptError}
					isPending={updateMutation.isPending}
					isSuccess={updateMutation.isSuccess}
					isError={updateMutation.isError}
					errorMessage={updateMutation.error?.message}
				/>
			)}

			{activeTab === 'pipeline' && (
				<PipelineSettingsForm
					autoMerge={autoMerge}
					setAutoMerge={(value) => {
						setAutoMerge(value);
						updateMutation.reset();
					}}
					skipRespondToReviewOnMinors={skipRespondToReviewOnMinors}
					setSkipRespondToReviewOnMinors={(value) => {
						setSkipRespondToReviewOnMinors(value);
						updateMutation.reset();
					}}
					handleSubmit={handlePipelineSubmit}
					handleReset={handlePipelineReset}
					isDirty={isPipelineDirty}
					isPending={updateMutation.isPending}
					isSuccess={updateMutation.isSuccess}
					isError={updateMutation.isError}
					errorMessage={updateMutation.error?.message}
				/>
			)}

			{activeTab === 'boardMapping' && (
				<GitHubProjectsMappingForm
					form={boardMapping}
					setProjectId={handleBoardMappingProjectId}
					setStatusFieldId={handleBoardMappingStatusFieldId}
					setStatusOption={handleBoardMappingStatusOption}
					handleSubmit={handleBoardMappingSubmit}
					handleReset={handleBoardMappingReset}
					isDirty={isBoardMappingFormDirty}
					isPending={updateMutation.isPending}
					isSuccess={updateMutation.isSuccess}
					isError={updateMutation.isError}
					errorMessage={updateMutation.error?.message}
				/>
			)}

			{activeTab === 'credentials' && <CredentialsPanel projectId={projectId} />}
		</div>
	);
}

export const projectDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects/$projectId',
	component: ProjectDetailRouteComponent,
});
