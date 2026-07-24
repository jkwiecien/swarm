import type { WSContext } from 'hono/ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger.js';
import {
	deregisterConnection,
	isWorkerConnected,
	registerConnection,
	sendToWorker,
} from '@/router/worker-connections.js';
import { type ControlPlaneMessage, WS_CLOSE } from '@/transport/protocol.js';

/** WebSocket `readyState`: OPEN. */
const OPEN = 1;
/** WebSocket `readyState`: CLOSED. */
const CLOSED = 3;

type FakeWs = WSContext & {
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	readyState: number;
};

/** A fake `WSContext` exposing spyable `send`/`close` and a settable `readyState`. */
function fakeWs(readyState = OPEN): FakeWs {
	return { send: vi.fn(), close: vi.fn(), readyState } as unknown as FakeWs;
}

const ACK: ControlPlaneMessage = { type: 'heartbeat-ack' };

// The registry `Map` is module-private and process-global, so each test uses its
// own worker id to stay independent (mirroring `../worker/run-cancellation.ts`,
// which likewise keeps no test-only reset).
describe('worker-connections registry', () => {
	beforeEach(() => vi.clearAllMocks());

	it('delivers a control-plane message to a registered, open socket', () => {
		const ws = fakeWs();
		registerConnection('worker-send', ws);

		expect(sendToWorker('worker-send', ACK)).toBe(true);
		expect(ws.send).toHaveBeenCalledWith(JSON.stringify(ACK));

		deregisterConnection('worker-send', ws);
	});

	it('returns false when sending to an unknown worker (never throws)', () => {
		expect(sendToWorker('worker-never-registered', ACK)).toBe(false);
	});

	it('returns false when the socket is not OPEN', () => {
		const ws = fakeWs(CLOSED);
		registerConnection('worker-closed', ws);

		expect(sendToWorker('worker-closed', ACK)).toBe(false);
		expect(ws.send).not.toHaveBeenCalled();

		deregisterConnection('worker-closed', ws);
	});

	it('returns false and logs when the underlying send throws', () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const ws = fakeWs();
		ws.send.mockImplementation(() => {
			throw new Error('socket write failed');
		});
		registerConnection('worker-throws', ws);

		expect(sendToWorker('worker-throws', ACK)).toBe(false);
		expect(warnSpy).toHaveBeenCalled();

		deregisterConnection('worker-throws', ws);
		warnSpy.mockRestore();
	});

	it('reports connectivity by registration and open state', () => {
		const ws = fakeWs();
		expect(isWorkerConnected('worker-conn')).toBe(false);

		registerConnection('worker-conn', ws);
		expect(isWorkerConnected('worker-conn')).toBe(true);

		// A registered-but-not-open socket reports not-connected.
		ws.readyState = CLOSED;
		expect(isWorkerConnected('worker-conn')).toBe(false);

		ws.readyState = OPEN;
		deregisterConnection('worker-conn', ws);
		expect(isWorkerConnected('worker-conn')).toBe(false);
	});

	it('deregister removes the socket so sends no longer reach it', () => {
		const ws = fakeWs();
		registerConnection('worker-dereg', ws);
		deregisterConnection('worker-dereg', ws);

		expect(sendToWorker('worker-dereg', ACK)).toBe(false);
		expect(ws.send).not.toHaveBeenCalled();
	});

	it('deregister with a different socket identity does not evict the live one', () => {
		const live = fakeWs();
		const stale = fakeWs();
		registerConnection('worker-identity', live);

		// A stale close for a socket that never was (or is no longer) the registered
		// one must not remove the live socket.
		deregisterConnection('worker-identity', stale);

		expect(isWorkerConnected('worker-identity')).toBe(true);
		expect(sendToWorker('worker-identity', ACK)).toBe(true);

		deregisterConnection('worker-identity', live);
	});

	it('a second register for the same worker evicts and closes the first', () => {
		const first = fakeWs();
		const second = fakeWs();
		registerConnection('worker-evict', first);
		registerConnection('worker-evict', second);

		// The superseded socket is closed with LEASE_LOST...
		expect(first.close).toHaveBeenCalledWith(WS_CLOSE.LEASE_LOST, expect.any(String));
		// ...and sends now reach the newer socket only.
		expect(sendToWorker('worker-evict', ACK)).toBe(true);
		expect(second.send).toHaveBeenCalledWith(JSON.stringify(ACK));
		expect(first.send).not.toHaveBeenCalled();

		deregisterConnection('worker-evict', second);
	});

	it('re-registering the identical socket does not close it', () => {
		const ws = fakeWs();
		registerConnection('worker-reregister', ws);
		registerConnection('worker-reregister', ws);

		expect(ws.close).not.toHaveBeenCalled();
		expect(isWorkerConnected('worker-reregister')).toBe(true);

		deregisterConnection('worker-reregister', ws);
	});
});
