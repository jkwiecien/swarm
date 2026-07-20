import { describe, expect, it } from 'vitest';

import {
	INITIAL_FENCING_TOKEN,
	isSessionLive,
	nextFencingToken,
	WorkerSessionHeldError,
	WorkerSessionSchema,
} from '@/identity/worker-session.js';

const BASE = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(BASE.getTime() + ms);

describe('nextFencingToken', () => {
	it('is strictly monotonic from the initial token', () => {
		let token = INITIAL_FENCING_TOKEN;
		const seen = [token];
		for (let i = 0; i < 5; i++) {
			const next = nextFencingToken(token);
			expect(next).toBeGreaterThan(token);
			token = next;
			seen.push(token);
		}
		expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
		// A replaced holder's token can never again equal a later one.
		expect(new Set(seen).size).toBe(seen.length);
	});
});

describe('isSessionLive (TTL boundary math)', () => {
	const TTL = 60_000;

	it('is live strictly before the TTL elapses', () => {
		expect(isSessionLive(BASE, TTL, at(0))).toBe(true);
		expect(isSessionLive(BASE, TTL, at(TTL - 1))).toBe(true);
	});

	it('is expired exactly at and after the TTL', () => {
		// Boundary: elapsed === TTL is expired, not live.
		expect(isSessionLive(BASE, TTL, at(TTL))).toBe(false);
		expect(isSessionLive(BASE, TTL, at(TTL + 1))).toBe(false);
	});
});

describe('WorkerSessionSchema', () => {
	const valid = {
		id: '11111111-1111-4111-8111-111111111111',
		workerId: '22222222-2222-4222-8222-222222222222',
		fencingToken: 1,
		lastHeartbeatAt: BASE,
		currentRunId: null,
		createdAt: BASE,
	};

	it('accepts a well-formed session with a null current run', () => {
		expect(WorkerSessionSchema.parse(valid)).toEqual(valid);
	});

	it('accepts a uuid current run reference', () => {
		const runId = '33333333-3333-4333-8333-333333333333';
		expect(WorkerSessionSchema.parse({ ...valid, currentRunId: runId }).currentRunId).toBe(runId);
	});

	it('rejects a non-positive or non-integer fencing token', () => {
		expect(() => WorkerSessionSchema.parse({ ...valid, fencingToken: 0 })).toThrow();
		expect(() => WorkerSessionSchema.parse({ ...valid, fencingToken: -1 })).toThrow();
		expect(() => WorkerSessionSchema.parse({ ...valid, fencingToken: 1.5 })).toThrow();
	});
});

describe('WorkerSessionHeldError', () => {
	it('names the contended worker and is a distinct type', () => {
		const err = new WorkerSessionHeldError('worker-9');
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('WorkerSessionHeldError');
		expect(err.workerId).toBe('worker-9');
		expect(err.message).toContain('worker-9');
	});
});
