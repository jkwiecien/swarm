import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	DELEGATION_EVENTS_FILENAME,
	DELEGATION_REVIEW_FILENAME,
	type DelegationObservation,
	DelegationObservationSchema,
	DelegationReviewSchema,
} from './native.js';

export function readDelegationObservations(cwd: string): DelegationObservation[] {
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
		});
	const reviewsPath = resolve(cwd, DELEGATION_REVIEW_FILENAME);
	if (!existsSync(reviewsPath)) return observations;
	try {
		const reviews = DelegationReviewSchema.parse(JSON.parse(readFileSync(reviewsPath, 'utf8')));
		const dispositionByContract = new Map(
			reviews.delegations.map((review) => [review.contractId, review.disposition]),
		);
		return observations.map((observation) => ({
			...observation,
			reviewDisposition:
				dispositionByContract.get(observation.contractId) ?? observation.reviewDisposition,
		}));
	} catch {
		return observations;
	}
}
