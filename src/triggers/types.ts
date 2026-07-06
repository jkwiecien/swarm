/**
 * Trigger types — how the worker decides *what* to do with a dequeued event,
 * mirroring Cascade's `src/triggers/types.ts` + `src/types` trigger interfaces.
 * One deliberate deviation: Cascade dispatches triggers router-side and ships
 * the result in the job; SWARM's worker owns the lookup (ai/ARCHITECTURE.md
 * "Components" — the worker "looks up the trigger handler for the event"), so
 * the job carries only the parsed event and the context is rebuilt here.
 *
 * A `TriggerResult` names one of the four pipeline phases (ai/ARCHITECTURE.md
 * "Pipeline phases") plus the inputs that phase's orchestrator
 * (`src/pipeline/*.ts`) needs — the handler resolves those from the event (and,
 * for the PM phases, an authoritative board re-read), and the worker's
 * `processJob` dispatches on `phase` and calls the matching `runXPhase`. The
 * result is a discriminated union so each phase only carries the inputs it
 * actually uses, and the worker's `switch` is exhaustive at compile time. These
 * are in-process shapes (the queue boundary is `src/queue/jobs.ts`), so plain
 * types, not Zod.
 */

import type { ProjectConfig } from '../config/schema.js';
import type { WorkItem } from '../pm/types.js';
import type { GitHubParsedEvent } from '../router/adapters/github.js';
import type { GitHubProjectsParsedEvent } from '../router/adapters/github-projects.js';

/**
 * What a trigger handler sees: the resolved project plus the parsed event,
 * discriminated by which router adapter produced it.
 */
export type TriggerContext = {
	project: ProjectConfig;
	/** GitHub's `X-GitHub-Delivery`, when the job carried one. */
	deliveryId?: string;
} & (
	| { source: 'github'; event: GitHubParsedEvent }
	| { source: 'github-projects'; event: GitHubProjectsParsedEvent }
);

export type TriggerSource = TriggerContext['source'];

/** The pipeline phase a matched trigger runs. */
export type TriggerPhase = 'planning' | 'implementation' | 'review' | 'respond-to-review';

/**
 * The `taskId` every result carries — the identifier the phase's worktree is
 * provisioned under (`task-<id>`), which is the linked issue/PR number.
 */
interface TriggerResultBase {
	taskId: string;
}

/**
 * Which pipeline phase to run, plus that phase's resolved inputs. The worker
 * supplies the ambient dependencies (project, PM provider, worktree manager);
 * the handler resolves everything here from the event.
 */
export type TriggerResult =
	| (TriggerResultBase & {
			phase: 'planning' | 'implementation';
			/** The board item that entered the triggering status — the work to do. */
			workItem: WorkItem;
	  })
	| (TriggerResultBase & {
			phase: 'review';
			/** The PR under review. */
			prNumber: string;
			/** The PR head commit the review is pinned to (`src/pipeline/review.ts`). */
			headSha: string;
	  })
	| (TriggerResultBase & {
			phase: 'respond-to-review';
			/** The PR the review was submitted on. */
			prNumber: string;
			/** The PR head branch the implementer checks out and pushes fixes to. */
			prBranch: string;
			/** The submitted review's numeric ID the implementer must answer. */
			reviewId: string;
	  });

export interface TriggerHandler {
	name: string;
	description: string;
	matches(ctx: TriggerContext): boolean;
	handle(ctx: TriggerContext): Promise<TriggerResult | null>;
}
