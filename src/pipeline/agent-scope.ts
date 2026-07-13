/**
 * Keep a worker-spawned agent inside the one phase the worker assigned it.
 * Project-scoped manual skills can otherwise match the same issue/PR language
 * and expand one phase into the entire pipeline, duplicating later agents.
 */
import { delegationGuardLines } from '@/delegation/native.js';

export function pipelinePhaseGuard(nativeDelegation = false): readonly string[] {
	return [
		'You are a SWARM pipeline agent assigned to exactly one phase. Perform only the',
		'phase described in this prompt. Do NOT invoke the `solve-issue` skill or any',
		'other skill/workflow that plans, implements, reviews, and responds end to end.',
		...delegationGuardLines(nativeDelegation),
		'Do NOT perform work belonging to another pipeline phase.',
		'The SWARM worker dispatches those phases separately with the correct persona,',
		"worktree, and lifecycle. When this phase's requested hand-off is complete, stop.",
	];
}
