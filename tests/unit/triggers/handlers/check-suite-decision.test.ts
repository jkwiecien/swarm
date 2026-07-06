import { describe, expect, it } from 'vitest';
import type { CheckSuiteStatus } from '@/integrations/scm/github/client.js';
import { decideCheckSuiteOutcome } from '@/triggers/handlers/check-suite-decision.js';

/** Build a `CheckSuiteStatus` from `[name, status, conclusion]` triples. */
function status(runs: Array<[string, string, string | null]>): CheckSuiteStatus {
	return {
		totalCount: runs.length,
		checkRuns: runs.map(([name, s, conclusion]) => ({ name, status: s, conclusion })),
	};
}

describe('decideCheckSuiteOutcome', () => {
	it('reviews when every check completed and none failed', () => {
		const decision = decideCheckSuiteOutcome(
			status([
				['build', 'completed', 'success'],
				['test', 'completed', 'success'],
			]),
			'9',
		);
		expect(decision).toEqual({ action: 'review' });
	});

	it('reviews when there are no checks at all', () => {
		expect(decideCheckSuiteOutcome(status([]), '9')).toEqual({ action: 'review' });
	});

	it('reviews when a completed check is skipped/neutral (not a failure)', () => {
		const decision = decideCheckSuiteOutcome(
			status([
				['build', 'completed', 'success'],
				['optional', 'completed', 'skipped'],
			]),
			'9',
		);
		expect(decision).toEqual({ action: 'review' });
	});

	it('defers, listing the incomplete checks, when a check is still running', () => {
		const decision = decideCheckSuiteOutcome(
			status([
				['build', 'completed', 'success'],
				['test', 'in_progress', null],
				['lint', 'queued', null],
			]),
			'9',
		);
		expect(decision).toMatchObject({ action: 'defer', incompleteChecks: ['test', 'lint'] });
	});

	it('defers even when an already-completed check failed (completion wins first)', () => {
		const decision = decideCheckSuiteOutcome(
			status([
				['test', 'completed', 'failure'],
				['build', 'in_progress', null],
			]),
			'9',
		);
		expect(decision).toMatchObject({ action: 'defer' });
	});

	it('skips when all checks completed and one failed', () => {
		const decision = decideCheckSuiteOutcome(
			status([
				['build', 'completed', 'success'],
				['test', 'completed', 'failure'],
			]),
			'9',
		);
		expect(decision).toMatchObject({ action: 'skip' });
	});

	it.each([
		'failure',
		'timed_out',
		'action_required',
	])('treats a %s conclusion as a failure → skip', (conclusion) => {
		expect(decideCheckSuiteOutcome(status([['test', 'completed', conclusion]]), '9')).toMatchObject(
			{ action: 'skip' },
		);
	});
});
