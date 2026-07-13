/**
 * SWARM project configuration — the single source of truth for a project's
 * shape (ai/CODING_STANDARDS.md "Zod is the source of truth"). Mirrors
 * Cascade's `src/config/schema.ts`: a central schema that composes each
 * provider's own schema *by import* rather than re-declaring its fields, so a
 * hand-written type and a hand-written validator can't quietly drift apart.
 *
 * Scope (SWARM-5, Phase 0): repo + worktree location, the GitHub Projects board
 * mapping, and credential *references*. The actual secrets are never stored
 * here — see `CredentialsSchema` below.
 */

import { z } from 'zod';
import { type AgentCli, AgentCliSchema } from '../harness/agent-cli.js';
import { AGENT_MODELS, ALL_AGENT_MODELS } from '../harness/models.js';
import { githubProjectsConfigSchema } from '../integrations/pm/github-projects/config-schema.js';

export const PROJECT_DEFAULTS = {
	baseBranch: 'main',
	branchPrefix: 'issue-',
	/** Mirrors the documented SWARM_WORKER_CONCURRENCY default. */
	maxConcurrentJobs: 1,
	/** Relative to `repoRoot`; matches the worktree lifecycle in ai/ARCHITECTURE.md. */
	worktreeRoot: '.swarm-workspaces',
	maxWorktrees: 10,
} as const;

/**
 * References to a project's GitHub credentials — the dual-persona tokens plus
 * the webhook-verification secret.
 *
 * These are *references*, never the secret values: each is a key into the
 * secret store (the Postgres `project_credentials` table / an env var name),
 * resolved at runtime and scoped via `AsyncLocalStorage` (ai/CODING_STANDARDS.md
 * "Scope credentials with AsyncLocalStorage"). Storing the raw tokens in the
 * project config JSON would defeat that scoping and leak them into logs and
 * DB rows — PROJECT.md §6.1 keeps secrets out of config on purpose.
 *
 * The implementer/reviewer split is Cascade's loop-prevention model
 * (ai/CODING_STANDARDS.md "Loop prevention"): a persona never reacts to its own
 * output, so the two identities must resolve to two distinct credentials.
 */
export const CredentialsSchema = z
	.object({
		/** Reference to the implementer-persona GitHub token in the secret store. */
		implementer: z.string().min(1),
		/** Reference to the reviewer-persona GitHub token in the secret store. */
		reviewer: z.string().min(1),
		/** Reference to the GitHub webhook HMAC secret used to verify inbound events. */
		webhookSecret: z.string().min(1),
	})
	.describe('References to a project GitHub credentials (never the secrets themselves)');

/**
 * Per-phase agent CLI/model override. Both fields are optional — omit `cli` to
 * keep the phase's own coded default (`DEFAULT_PLANNING_CLI` and friends,
 * `src/pipeline/*.ts`), omit `model` to run on that CLI's own default model.
 *
 * `model`, when given, must be one of `AGENT_MODELS[cli]` (`src/harness/models.ts`)
 * — `claude`'s short aliases (`sonnet`, `opus`, …), `agy`'s exact `agy models`
 * display strings (`"Gemini 3.5 Flash (High)"`, …), or `codex`'s short model
 * identifiers (`"gpt-5.6-sol"`, `"gpt-5.4-mini"`, …). When `cli` itself is
 * omitted, `model` is checked against the union of all lists, since the
 * phase's actual coded-default `cli` isn't known at the config-schema layer.
 */
export const AgentConfigSchema = z
	.object({
		cli: AgentCliSchema.optional(),
		model: z.string().min(1).optional(),
		/** A bounded per-phase timeout: 5–45 minutes, stored in milliseconds. */
		timeoutMs: z
			.number()
			.int()
			.min(5 * 60 * 1000)
			.max(45 * 60 * 1000)
			.optional(),
	})
	.refine(
		(agent) => {
			if (!agent.model) return true;
			const allowed = agent.cli ? AGENT_MODELS[agent.cli] : ALL_AGENT_MODELS;
			return (allowed as readonly string[]).includes(agent.model);
		},
		{ message: 'model must be one of the known models for its cli (src/harness/models.ts)' },
	)
	.describe('Per-phase agent CLI/model override');

/**
 * Per-CLI default model — the model used when a phase specifies (or falls back
 * to) a given CLI but doesn't set its own per-phase model override. Configuring
 * `defaults: { claude: "sonnet" }` means every claude-phase without an explicit
 * model runs on sonnet, rather than whatever the `claude` binary itself would
 * pick.
 *
 * Each key must be a known `AgentCli`, and the value must be valid for that CLI
 * per `AGENT_MODELS` — the same validation `AgentConfigSchema.model` uses, just
 * keyed by CLI instead of by phase.
 */
export const AgentDefaultsSchema = z
	.record(AgentCliSchema, z.string().min(1).optional())
	.refine(
		(defaults) => {
			for (const [cli, model] of Object.entries(defaults)) {
				if (!model) continue;
				const allowed = AGENT_MODELS[cli as AgentCli];
				if (!allowed) return false;
				if (!(allowed as readonly string[]).includes(model)) return false;
			}
			return true;
		},
		{
			message:
				'each default model must be one of the known models for its cli (src/harness/models.ts)',
		},
	)
	.describe('Per-CLI default model — used when a phase omits its own model override');

export const DelegationConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		/**
		 * Per-CLI lighter model a curated delegation child runs under (the phase's
		 * own CLI, pinned down a tier). Omitted CLIs fall back to the coded defaults
		 * in `src/delegation/native.ts` (`DEFAULT_CHILD_MODEL`): Claude→haiku,
		 * Codex→gpt-5.4-mini. Antigravity cannot host a child (ai/RULES.md §6, #185).
		 */
		childModels: z
			.object({
				claude: z.string().min(1).optional(),
				codex: z.string().min(1).optional(),
			})
			.optional(),
		minimumSemanticOperations: z.number().int().min(3).default(3),
		phases: z
			.object({
				planning: z.boolean().optional(),
				implementation: z.boolean().optional(),
				review: z.boolean().optional(),
				respondToReview: z.boolean().optional(),
				respondToCi: z.boolean().optional(),
				resolveConflicts: z.boolean().optional(),
			})
			.default({ implementation: true }),
	})
	.describe('Bounded curated semantic delegation policy (SWARM-orchestrated child runs)');

/**
 * Per-phase agent overrides, keyed by the same phase names the trigger/worker
 * layer already uses (`TriggerResult['phase']`, `src/triggers/types.ts`) —
 * camelCased to match this config's other multi-word keys (`statusOptions`'s
 * `inProgress`/`inReview`) rather than the kebab-case wire form. Every key is
 * optional; an entirely absent `agents` block (or an absent phase within it)
 * means every phase keeps running on its coded default, unchanged from before
 * this existed.
 *
 * `defaults` sets a per-CLI default model (e.g. `{ claude: "sonnet" }`) — the
 * fallback when a phase specifies (or inherits) a CLI but doesn't set its own
 * `model`. Without it, the CLI runs with its own built-in default.
 */
export const AgentsConfigSchema = z
	.object({
		defaults: AgentDefaultsSchema.optional(),
		delegation: DelegationConfigSchema.optional(),
		planning: AgentConfigSchema.optional(),
		implementation: AgentConfigSchema.optional(),
		review: AgentConfigSchema.optional(),
		respondToReview: AgentConfigSchema.optional(),
		respondToCi: AgentConfigSchema.optional(),
		resolveConflicts: AgentConfigSchema.optional(),
	})
	.describe('Per-phase agent CLI/model overrides — omit any phase to keep its coded default');

/**
 * Per-phase pipeline controls. Planning and Implementation configure whether
 * they move the board item on completion by themselves or leave that to a
 * human. The SCM-event-driven Review, Respond-to-review, and Respond-to-CI
 * phases can each be disabled. `autoAdvance` governs only the
 * *end-of-phase* move (Planning → "ToDo", Implementation → "In review") —
 * Implementation's separate pickup report (→ "In progress" as soon as it
 * starts) is unconditional either way, since it's a status report, not a
 * transition a human would want to gate.
 */
export const PipelineConfigSchema = z
	.object({
		/**
		 * Whether Planning moves the item to "ToDo" once it posts the plan.
		 * Unset (or the whole `pipeline.planning` block omitted) defaults to
		 * `false`: a human reviews the plan and moves the item themselves to
		 * greenlight Implementation.
		 *
		 * `autoSplit` (default `true`) lets the planning agent decompose a task it
		 * judges too large for a single PR: the original item becomes the smaller
		 * first task (re-scoped, possibly renamed), and the remaining work is spawned
		 * as sibling items that are each planned automatically but never auto-advance
		 * to "ToDo" — a human moves those in the order they choose (`src/pipeline/planning.ts`).
		 */
		planning: z
			.object({ autoAdvance: z.boolean().optional(), autoSplit: z.boolean().optional() })
			.optional(),
		/**
		 * Whether Implementation moves the item to "In review" once it opens the
		 * PR. Unset (or the whole `pipeline.implementation` block omitted)
		 * defaults to `true`: unlike Planning's plan — a judgment call worth a
		 * human look before committing to code — the opened PR *is* the request
		 * for that look, so there's nothing to gate on first.
		 */
		implementation: z.object({ autoAdvance: z.boolean().optional() }).optional(),
		review: z.object({ enabled: z.boolean().optional() }).optional(),
		respondToReview: z
			.object({
				enabled: z.boolean().optional(),
				autoMerge: z.boolean().optional(),
				/** Skip approval/comment reviews so only requested changes consume a response run. */
				skipOnMinors: z.boolean().optional(),
			})
			.optional(),
		respondToCi: z.object({ enabled: z.boolean().optional() }).optional(),
	})
	.refine(
		(pipeline) => pipeline.review?.enabled !== false || pipeline.respondToReview?.enabled === false,
		{
			message: 'Respond-to-review cannot be enabled when Review is disabled',
			path: ['respondToReview', 'enabled'],
		},
	)
	.describe('Per-phase pipeline controls');

export const WorktreeRetentionConfigSchema = z
	.object({
		/**
		 * How many of the project's most-recently-active task-<id> worktrees to
		 * keep; the rest are candidates for pruning (subject to the in-flight and
		 * uncommitted-changes safety checks — see src/worktree/retention.ts).
		 */
		maxWorktrees: z.number().int().positive().default(PROJECT_DEFAULTS.maxWorktrees),
	})
	.describe('Retention policy for stale per-task worktrees under worktreeRoot');

export const ProjectConfigSchema = z.object({
	/** Stable internal identifier for this SWARM project (one Postgres row per project). */
	id: z.string().min(1),

	/** Human-facing name — also the `{project-name}` in the worktree paths (PROJECT.md §4.1). */
	name: z.string().min(1),

	/** The GitHub repository this project operates on, as `owner/repo`. */
	repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in format "owner/repo"'),

	/**
	 * Absolute path to the main repository checkout on the developer's machine
	 * (the "human workspace", `~/swarm/{project-name}/` in PROJECT.md §4.1). Task
	 * worktrees are created relative to this path.
	 */
	repoRoot: z.string().min(1),

	/**
	 * Directory under `repoRoot` where per-task git worktrees live
	 * (ai/ARCHITECTURE.md "Worktree lifecycle"). Relative, not absolute, so it
	 * travels with `repoRoot`.
	 */
	worktreeRoot: z.string().min(1).default(PROJECT_DEFAULTS.worktreeRoot),

	/** Branch task worktrees are cut from and PRs target. */
	baseBranch: z.string().min(1).default(PROJECT_DEFAULTS.baseBranch),

	/** Prefix for task branch names — SWARM's convention is `issue-<n>-<slug>`. */
	branchPrefix: z.string().default(PROJECT_DEFAULTS.branchPrefix),

	/** Maximum number of jobs this project may run concurrently. */
	maxConcurrentJobs: z.number().int().positive().default(PROJECT_DEFAULTS.maxConcurrentJobs),

	/**
	 * PM provider discriminator. SWARM has exactly one provider for the MVP;
	 * the object shape (rather than a bare field) mirrors Cascade so a second
	 * provider could be added later without reshaping the config.
	 */
	pm: z
		.object({
			type: z.literal('github-projects').default('github-projects'),
		})
		.default({ type: 'github-projects' }),

	/** The GitHub Projects board mapping — composed from the provider's own schema. */
	githubProjects: githubProjectsConfigSchema,

	/** References to the project's GitHub credentials (see `CredentialsSchema`). */
	credentials: CredentialsSchema,

	/** Per-phase agent CLI/model overrides. Omit entirely to keep every phase's coded default. */
	agents: AgentsConfigSchema.optional(),

	/** Per-phase autonomous board-move control. Omit entirely to keep the coded defaults. */
	pipeline: PipelineConfigSchema.optional(),

	/** Per-project worktree retention policy (`WorktreeRetentionConfig`) — nullable: most projects omit it and use the coded default. */
	worktreeRetention: WorktreeRetentionConfigSchema.optional(),
});

export const SwarmConfigSchema = z.object({
	projects: z.array(ProjectConfigSchema).min(1),
});

export type Credentials = z.infer<typeof CredentialsSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type DelegationConfig = z.infer<typeof DelegationConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export type WorktreeRetentionConfig = z.infer<typeof WorktreeRetentionConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

/**
 * Parse and validate an untrusted config value. Throws `ZodError` on invalid
 * input — a malformed config is a deployment error, not a "not found" lookup,
 * so it throws rather than returning null (ai/CODING_STANDARDS.md "Error handling").
 */
export function validateConfig(config: unknown): SwarmConfig {
	return SwarmConfigSchema.parse(config);
}
