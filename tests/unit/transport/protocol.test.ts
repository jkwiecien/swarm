import { describe, expect, it } from 'vitest';

import {
	ControlPlaneMessageSchema,
	DisconnectSchema,
	HandshakeRequestSchema,
	HandshakeResponseSchema,
	HeartbeatAckSchema,
	HeartbeatSchema,
	TRANSPORT_PROTOCOL_VERSION,
	WorkerStreamMessageSchema,
} from '@/transport/protocol.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

describe('transport protocol schemas', () => {
	describe('HandshakeRequestSchema', () => {
		const valid = {
			credential: 'raw-worker-credential',
			daemonVersion: '1.2.3',
			hostname: 'ada-laptop',
			capabilities: ['claude', 'codex'],
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		};

		it('accepts a well-formed handshake request', () => {
			expect(HandshakeRequestSchema.parse(valid)).toEqual(valid);
		});

		it('rejects an empty credential', () => {
			expect(HandshakeRequestSchema.safeParse({ ...valid, credential: '' }).success).toBe(false);
		});

		it('rejects an empty capability set', () => {
			expect(HandshakeRequestSchema.safeParse({ ...valid, capabilities: [] }).success).toBe(false);
		});

		it('rejects an unknown CLI in capabilities', () => {
			expect(
				HandshakeRequestSchema.safeParse({ ...valid, capabilities: ['claude', 'cursor'] }).success,
			).toBe(false);
		});

		it('rejects a missing field', () => {
			const { hostname, ...withoutHostname } = valid;
			expect(HandshakeRequestSchema.safeParse(withoutHostname).success).toBe(false);
		});
	});

	describe('HandshakeResponseSchema', () => {
		const valid = {
			authenticated: true as const,
			workerId: WORKER_ID,
			sessionId: SESSION_ID,
			fencingToken: 1,
			heartbeatTtlMs: 60_000,
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		};

		it('round-trips a success response', () => {
			expect(HandshakeResponseSchema.parse(valid)).toEqual(valid);
		});

		it('rejects authenticated: false (a failure never uses this shape)', () => {
			expect(HandshakeResponseSchema.safeParse({ ...valid, authenticated: false }).success).toBe(
				false,
			);
		});

		it('rejects a non-positive fencing token', () => {
			expect(HandshakeResponseSchema.safeParse({ ...valid, fencingToken: 0 }).success).toBe(false);
		});
	});

	describe('HeartbeatSchema', () => {
		it('accepts a heartbeat with no health', () => {
			expect(HeartbeatSchema.parse({ type: 'heartbeat', fencingToken: 2 })).toEqual({
				type: 'heartbeat',
				fencingToken: 2,
			});
		});

		it('accepts optional health telemetry', () => {
			const frame = {
				type: 'heartbeat' as const,
				fencingToken: 2,
				health: { cpuLoadPercent: 42, availableRamBytes: 1024 },
			};
			expect(HeartbeatSchema.parse(frame)).toEqual(frame);
		});

		it('rejects a cpu load above 100', () => {
			expect(
				HeartbeatSchema.safeParse({
					type: 'heartbeat',
					fencingToken: 2,
					health: { cpuLoadPercent: 101 },
				}).success,
			).toBe(false);
		});

		it('rejects the wrong type discriminator', () => {
			expect(HeartbeatSchema.safeParse({ type: 'heartbeat-ack', fencingToken: 2 }).success).toBe(
				false,
			);
		});
	});

	describe('WorkerStreamMessageSchema (worker→cloud union)', () => {
		it('parses a heartbeat frame', () => {
			const parsed = WorkerStreamMessageSchema.parse({ type: 'heartbeat', fencingToken: 5 });
			expect(parsed.type).toBe('heartbeat');
		});

		it('rejects a control-plane frame carried the wrong direction', () => {
			expect(WorkerStreamMessageSchema.safeParse({ type: 'heartbeat-ack' }).success).toBe(false);
		});
	});

	describe('ControlPlaneMessageSchema (cloud→worker union)', () => {
		it('parses a heartbeat-ack frame', () => {
			expect(ControlPlaneMessageSchema.parse({ type: 'heartbeat-ack' })).toEqual({
				type: 'heartbeat-ack',
			});
		});

		it('parses a disconnect frame with a reason', () => {
			expect(HeartbeatAckSchema.safeParse({ type: 'heartbeat-ack' }).success).toBe(true);
			expect(ControlPlaneMessageSchema.parse({ type: 'disconnect', reason: 'lease lost' })).toEqual(
				{ type: 'disconnect', reason: 'lease lost' },
			);
		});

		it('rejects a disconnect frame missing its reason', () => {
			expect(DisconnectSchema.safeParse({ type: 'disconnect' }).success).toBe(false);
		});

		it('rejects a worker→cloud frame carried the wrong direction', () => {
			expect(
				ControlPlaneMessageSchema.safeParse({ type: 'heartbeat', fencingToken: 1 }).success,
			).toBe(false);
		});
	});
});
