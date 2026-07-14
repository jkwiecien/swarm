import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPLEMENTATION_CLI } from '@/pipeline/implementation.js';
import { DEFAULT_PLANNING_CLI } from '@/pipeline/planning.js';
import { DEFAULT_RESOLVE_CONFLICTS_CLI } from '@/pipeline/resolve-conflicts.js';
import { DEFAULT_RESPOND_CI_CLI } from '@/pipeline/respond-to-ci.js';
import { DEFAULT_RESPOND_CLI } from '@/pipeline/respond-to-review.js';
import { DEFAULT_REVIEW_CLI } from '@/pipeline/review.js';
import { DEFAULT_ENGINE } from '@/worker/consumer.js';

// The worker's DEFAULT_ENGINE duplicates each phase's coded DEFAULT_*_CLI so it
// can resolve the effective engine persisted on a run row *before* the run
// finishes (issue #169). Nothing enforces that duplication at runtime — a
// defaulted run's persisted engine would silently diverge from the CLI the phase
// actually launches during the running/deferred window if a phase default moved
// while DEFAULT_ENGINE stayed put. This guards that invariant.
describe('DEFAULT_ENGINE stays in sync with every phase default', () => {
	it.each([
		['planning', DEFAULT_PLANNING_CLI],
		['implementation', DEFAULT_IMPLEMENTATION_CLI],
		['review', DEFAULT_REVIEW_CLI],
		['respond-to-review', DEFAULT_RESPOND_CLI],
		['respond-to-ci', DEFAULT_RESPOND_CI_CLI],
		['resolve-conflicts', DEFAULT_RESOLVE_CONFLICTS_CLI],
	])('%s coded default equals DEFAULT_ENGINE', (_phase, phaseDefault) => {
		expect(phaseDefault).toBe(DEFAULT_ENGINE);
	});
});
