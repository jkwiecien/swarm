/**
 * Small helpers shared by the pipeline-phase trigger handlers
 * (`src/triggers/handlers/*`). Kept here so each handler file stays focused on
 * its matching/dispatch logic.
 */

/**
 * The issue/PR number embedded in a GitHub Issue/PR web URL
 * (`https://github.com/owner/repo/issues/10` → `10`,
 * `.../pull/42` → `42`), or `undefined` when the URL carries none (e.g. a draft
 * item, which has no backing Issue).
 *
 * The pipeline phases take the linked issue number as their `taskId`
 * (the worktree path suffix), and a work item read from GitHub Projects exposes
 * its backing Issue/PR only through this URL — the provider-agnostic `WorkItem`
 * (`src/pm/types.ts`) has no GitHub-specific `number` field — so this is where
 * the number is recovered.
 */
export function issueNumberFromUrl(url: string): string | undefined {
	const match = url.match(/\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/);
	return match?.[1];
}
