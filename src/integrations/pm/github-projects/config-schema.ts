/**
 * GitHub Projects (v2) provider integration config schema.
 *
 * This is SWARM's only PM provider (see ai/ARCHITECTURE.md "PM: GitHub
 * Projects") and has no Cascade equivalent — Cascade ships Trello/JIRA/Linear,
 * not GitHub Projects. It follows the same `config-schema.ts` shape those
 * providers use (Zod schema + `z.infer` type, the provider owns its own
 * contract) so the central project config can compose it by import rather than
 * re-declaring the board mapping — the single-source-of-truth rule from
 * ai/CODING_STANDARDS.md "Zod is the source of truth".
 *
 * This schema covers only the board *mapping* — the opaque GraphQL node IDs
 * SWARM needs to read and move items. GitHub credentials (implementer/reviewer
 * tokens, webhook secret) are referenced from the project config's
 * `credentials` block, not stored here (PROJECT.md §6.1).
 *
 * The string IDs below are branded at the boundary via `src/pm/ids.ts`
 * (`parseProjectV2Id`, `parseFieldId`, `parseSingleSelectOptionId`) — storing
 * them as plain validated strings here keeps the config round-trippable, the
 * same way Cascade keeps state IDs as strings in config and brands them when
 * they leave the config layer.
 */

import { z } from 'zod';

export const githubProjectsConfigSchema = z
	.object({
		/**
		 * The Projects v2 project node ID — the board itself
		 * (e.g. `PVT_kwHOAC3TF84BcNwD`). GitHub Projects v2 is GraphQL-only, so
		 * this is a node ID, not the human-facing project number.
		 */
		projectId: z.string().min(1),

		/**
		 * The single-select "Status" field's node ID
		 * (e.g. `PVTSSF_lAHOAC3TF84BcNwDzhW4MKo`). Moving an item through the
		 * pipeline means writing one of `statusOptions`' values to this field.
		 */
		statusFieldId: z.string().min(1),

		/**
		 * Mapping from SWARM pipeline status keys to the Status field's
		 * single-select *option* IDs (not option names — names are display-only
		 * and rename-prone; the option ID is stable).
		 *
		 * Recognized keys mirror the board's Status options (ai/RULES.md §5) plus
		 * the pipeline phases (ai/ARCHITECTURE.md §"Pipeline phases"):
		 * `backlog`, `ready`, `planning`, `inProgress`, `inReview`, `done`.
		 * Kept as an open record — a board may add or omit options, and validating
		 * exact key presence belongs to setup/wizard code, not this schema. The
		 * one bound the schema does enforce: the record can't be empty, since a
		 * board mapping with zero status→optionId entries gives the PM adapter no
		 * transition targets to move items to.
		 */
		statusOptions: z
			.record(z.string().min(1), z.string().min(1))
			.refine((r) => Object.keys(r).length > 0, {
				message: 'statusOptions must map at least one pipeline status to an option ID',
			}),

		/**
		 * Optional mapping from SWARM phase keys (`phase-0` … `phase-5`) to the
		 * repo label names used to mirror them (ai/RULES.md §5 — the board has no
		 * native "phase" field). Optional because phase labels are organizational,
		 * not required for the pipeline to run.
		 */
		phaseLabels: z.record(z.string().min(1), z.string().min(1)).optional(),
	})
	.describe('GitHub Projects (v2) board integration config');

export type GitHubProjectsIntegrationConfig = z.infer<typeof githubProjectsConfigSchema>;
