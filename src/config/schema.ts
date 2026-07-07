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
import { AgentCliSchema } from '../harness/agent-cli.js';
import { githubProjectsConfigSchema } from '../integrations/pm/github-projects/config-schema.js';

export const PROJECT_DEFAULTS = {
	baseBranch: 'main',
	branchPrefix: 'issue-',
	/** Relative to `repoRoot`; matches the worktree lifecycle in ai/ARCHITECTURE.md. */
	worktreeRoot: '.swarm-workspaces',
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
 * `model` isn't validated against a fixed list: `claude` and `agy` (the
 * Antigravity binary — see `src/harness/agent-cli.ts`) each accept their own
 * aliases/full names, and the harness passes the value straight through.
 */
export const AgentConfigSchema = z
	.object({
		cli: AgentCliSchema.optional(),
		model: z.string().min(1).optional(),
	})
	.describe('Per-phase agent CLI/model override');

/**
 * Per-phase agent overrides, keyed by the same phase names the trigger/worker
 * layer already uses (`TriggerResult['phase']`, `src/triggers/types.ts`) —
 * camelCased to match this config's other multi-word keys (`statusOptions`'s
 * `inProgress`/`inReview`) rather than the kebab-case wire form. Every key is
 * optional; an entirely absent `agents` block (or an absent phase within it)
 * means every phase keeps running on its coded default, unchanged from before
 * this existed.
 */
export const AgentsConfigSchema = z
	.object({
		planning: AgentConfigSchema.optional(),
		implementation: AgentConfigSchema.optional(),
		review: AgentConfigSchema.optional(),
		respondToReview: AgentConfigSchema.optional(),
		respondToCi: AgentConfigSchema.optional(),
	})
	.describe('Per-phase agent CLI/model overrides — omit any phase to keep its coded default');

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
});

export const SwarmConfigSchema = z.object({
	projects: z.array(ProjectConfigSchema).min(1),
});

export type Credentials = z.infer<typeof CredentialsSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
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
