import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	DELEGATION_EVENTS_FILENAME,
	DELEGATION_REVIEW_FILENAME,
	type DelegationObservation,
	DelegationObservationSchema,
	DelegationReviewSchema,
} from './native.js';

export function readDelegationObservations(
	cwd: string,
	scope?: { parentSessionId?: string; parentRunId?: string },
): DelegationObservation[] {
	const eventsPath = resolve(cwd, DELEGATION_EVENTS_FILENAME);
	if (!existsSync(eventsPath)) return [];
	const observations = readFileSync(eventsPath, 'utf8')
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const parsed = DelegationObservationSchema.safeParse(JSON.parse(line));
				return parsed.success ? [parsed.data] : [];
			} catch {
				return [];
			}
		})
		.filter((observation) => {
			// Prefer the run id: it is the SWARM-controlled link the `swarm delegate`
			// command always stamps (from SWARM_PARENT_RUN_ID), whereas a parent
			// session id isn't known up front for every CLI (codex/agy assign their
			// own post-run). Fall back to session id, then to unscoped.
			if (scope?.parentRunId) return observation.parentRunId === scope.parentRunId;
			if (scope?.parentSessionId) return observation.parentSessionId === scope.parentSessionId;
			return true;
		});
	const reviewsPath = resolve(cwd, DELEGATION_REVIEW_FILENAME);
	if (!existsSync(reviewsPath)) return observations;
	try {
		const reviews = DelegationReviewSchema.parse(JSON.parse(readFileSync(reviewsPath, 'utf8')));
		const dispositionByInvocation = new Map(
			reviews.delegations.map((review) => [
				`${review.invocationId}\0${review.contractId}`,
				review.disposition,
			]),
		);
		return observations.map((observation) => ({
			...observation,
			reviewDisposition:
				dispositionByInvocation.get(`${observation.invocationId}\0${observation.contractId}`) ??
				observation.reviewDisposition,
		}));
	} catch {
		return observations;
	}
}
