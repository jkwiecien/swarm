import { describe, expect, it } from 'vitest';
import {
	DEFAULT_WORKER_CONCURRENCY,
	DEFAULT_WORKER_LOCK_DURATION_MS,
	MAX_WORKER_LOCK_RENEW_TIME_MS,
	resolveWorkerConcurrency,
	resolveWorkerLockOptions,
} from '@/worker/runtime-options.js';

describe('resolveWorkerLockOptions', () => {
	it('uses a long lock with frequent renewal by default', () => {
		expect(resolveWorkerLockOptions(undefined)).toEqual({
			lockDuration: DEFAULT_WORKER_LOCK_DURATION_MS,
			lockRenewTime: MAX_WORKER_LOCK_RENEW_TIME_MS,
		});
	});

	it('caps renewal at half of a short custom lock', () => {
		expect(resolveWorkerLockOptions('20000')).toEqual({
			lockDuration: 20_000,
			lockRenewTime: 10_000,
		});
	});

	it.each(['0', '-1', 'nope', '1.5'])('rejects invalid lock duration %s', (value) => {
		expect(() => resolveWorkerLockOptions(value)).toThrow(
			/SWARM_WORKER_LOCK_DURATION_MS must be a positive integer/,
		);
	});
});

describe('resolveWorkerConcurrency', () => {
	it('defaults to 1 when neither flag nor env is set', () => {
		expect(resolveWorkerConcurrency([], undefined)).toBe(DEFAULT_WORKER_CONCURRENCY);
		expect(DEFAULT_WORKER_CONCURRENCY).toBe(1);
	});

	it('reads the SWARM_WORKER_CONCURRENCY env var when there is no flag', () => {
		expect(resolveWorkerConcurrency([], '3')).toBe(3);
	});

	it.each([
		['--concurrency 2 (separate arg)', ['--concurrency', '2']],
		['--concurrency=2 (inline)', ['--concurrency=2']],
	])('the launch flag wins over the env var: %s', (_label, argv) => {
		// env says 1, flag says 2 — the flag must win.
		expect(resolveWorkerConcurrency(argv, '1')).toBe(2);
	});

	it('ignores unrelated argv and falls back to the env var', () => {
		expect(resolveWorkerConcurrency(['--foo', 'bar', '--baz'], '4')).toBe(4);
	});

	it('rejects an invalid env value, naming the env var', () => {
		expect(() => resolveWorkerConcurrency([], '0')).toThrow(
			/SWARM_WORKER_CONCURRENCY must be a positive integer/,
		);
	});

	it.each([
		['non-numeric', ['--concurrency', 'nope']],
		['fractional', ['--concurrency', '1.5']],
		['zero', ['--concurrency=0']],
		['value-less', ['--concurrency']],
	])('rejects an invalid flag value, naming the flag: %s', (_label, argv) => {
		expect(() => resolveWorkerConcurrency(argv, '1')).toThrow(
			/--concurrency must be a positive integer/,
		);
	});
});
