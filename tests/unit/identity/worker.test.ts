import { describe, expect, it } from 'vitest';

import {
	WorkerCapabilitiesSchema,
	WorkerDisplayNameSchema,
	WorkerSchema,
} from '@/identity/worker.js';

const validWorker = {
	id: '11111111-1111-4111-8111-111111111111',
	ownerUserId: '22222222-2222-4222-8222-222222222222',
	displayName: 'ada-laptop',
	capabilities: ['claude', 'codex'],
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('WorkerCapabilitiesSchema', () => {
	it('rejects an empty set', () => {
		expect(() => WorkerCapabilitiesSchema.parse([])).toThrow();
	});

	it('de-duplicates repeated CLIs', () => {
		expect(WorkerCapabilitiesSchema.parse(['claude', 'claude', 'codex'])).toEqual([
			'claude',
			'codex',
		]);
	});

	it('rejects an unknown CLI', () => {
		expect(() => WorkerCapabilitiesSchema.parse(['claude', 'copilot'])).toThrow();
	});
});

describe('WorkerDisplayNameSchema', () => {
	it('trims surrounding whitespace', () => {
		expect(WorkerDisplayNameSchema.parse('  ada-laptop  ')).toBe('ada-laptop');
	});

	it('rejects an empty (or whitespace-only) name', () => {
		expect(() => WorkerDisplayNameSchema.parse('')).toThrow();
		expect(() => WorkerDisplayNameSchema.parse('   ')).toThrow();
	});

	it('rejects a name longer than 80 chars', () => {
		expect(() => WorkerDisplayNameSchema.parse('a'.repeat(81))).toThrow();
	});
});

describe('WorkerSchema', () => {
	it('round-trips a valid worker', () => {
		expect(WorkerSchema.parse(validWorker)).toEqual(validWorker);
	});

	it('rejects a non-uuid id', () => {
		expect(() => WorkerSchema.parse({ ...validWorker, id: 'not-a-uuid' })).toThrow();
	});

	it('rejects a non-uuid ownerUserId', () => {
		expect(() => WorkerSchema.parse({ ...validWorker, ownerUserId: 'nope' })).toThrow();
	});

	it('has no credential/hash field in the read model', () => {
		const parsed = WorkerSchema.parse(validWorker);
		expect(parsed).not.toHaveProperty('credentialHash');
		expect(parsed).not.toHaveProperty('credential');
	});
});
