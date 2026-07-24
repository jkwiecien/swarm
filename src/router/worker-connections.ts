/**
 * Connected-worker registry for the router's worker transport (ADR-003 §2). A
 * process-local map of `workerId → live /worker/stream WSContext`, plus the
 * server→worker push primitive the control plane uses to hand a
 * `ControlPlaneMessage` (a `TaskAssignment`, once phase 4 composes one) to a
 * specific connected daemon.
 *
 * Factored out of the socket glue (`./worker-transport.ts`) so it is unit-testable
 * with a fake `WSContext` and never needs a live socket — the same reason
 * `handleHandshake`/`handleWorkerStreamFrame` are already factored, and mirroring
 * the module-level registry in `../worker/run-cancellation.ts`. The `Map` is
 * module-private; callers touch it only through the exported functions.
 *
 * Single-process assumption: the MVP router runs as one process and a worker is
 * connected to exactly one router instance, so this in-process map is a complete
 * view of who is reachable *from here*. Multi-process/multi-router fan-out (a
 * shared routing table) is out of scope and belongs to a later phase.
 *
 * This module adds no dispatch behavior. Register/deregister keep the map in step
 * with the socket lifecycle, and `sendToWorker` is the primitive a future dispatch
 * path calls — nothing composes or pushes a `TaskAssignment` yet.
 */

import type { WSContext } from 'hono/ws';

import { logger } from '../lib/logger.js';
import { type ControlPlaneMessage, WS_CLOSE } from '../transport/protocol.js';

/** `WSContext.readyState` value for an open socket (the WebSocket `OPEN` state). */
const WS_OPEN = 1;

/**
 * Live `/worker/stream` sockets keyed by `workerId`. Module-private: at most one
 * authenticated connection per worker in this process, a newer connection evicting
 * an older one (see {@link registerConnection}).
 */
const connections = new Map<string, WSContext>();

/**
 * Record `ws` as the live socket for `workerId`, evicting any prior socket first.
 * A newer daemon supersedes an older one — consistent with the fencing-token model
 * (a fresh handshake bumps the fencing token, so the old session is already stale)
 * — so the previous socket is closed with `LEASE_LOST` before the new one is
 * stored. Re-registering the identical socket leaves it in place without closing
 * it.
 */
export function registerConnection(workerId: string, ws: WSContext): void {
	const existing = connections.get(workerId);
	if (existing && existing !== ws) {
		// Supersede: a newer connection authenticated for this worker. Close the stale
		// socket so the old daemon stops heartbeating a lease it no longer holds. Its
		// own `onClose` deregister is then a no-op (the identity check below sees the
		// newer socket). Best-effort: a close failure must not block the new registration.
		try {
			existing.close(WS_CLOSE.LEASE_LOST, 'superseded by a newer connection');
		} catch (err) {
			logger.warn('worker connection eviction close failed', {
				workerId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	connections.set(workerId, ws);
}

/**
 * Remove `workerId`'s socket from the registry, but only when the currently stored
 * socket is `ws` itself. The identity check means a stale `onClose`/`onError` for a
 * superseded socket cannot evict the newer socket that replaced it.
 */
export function deregisterConnection(workerId: string, ws: WSContext): void {
	if (connections.get(workerId) === ws) {
		connections.delete(workerId);
	}
}

/**
 * Whether `workerId` has a live socket in *this* process — the transport being open
 * here, distinct from the DB `worker_sessions` lease (which can read live while the
 * socket is on another router or already gone). A registered-but-not-`OPEN` socket
 * reports not-connected.
 */
export function isWorkerConnected(workerId: string): boolean {
	const ws = connections.get(workerId);
	return ws !== undefined && ws.readyState === WS_OPEN;
}

/**
 * Push a `ControlPlaneMessage` to `workerId`'s live socket, returning whether it
 * was sent. Returns `false` — never throws — when the worker is not connected, its
 * socket is not `OPEN`, or the underlying `send` fails; a caller treats `false` as
 * "not delivered on the transport" and falls back (e.g. leaves the dispatch queued).
 */
export function sendToWorker(workerId: string, message: ControlPlaneMessage): boolean {
	const ws = connections.get(workerId);
	if (!ws || ws.readyState !== WS_OPEN) {
		return false;
	}
	try {
		ws.send(JSON.stringify(message));
		return true;
	} catch (err) {
		logger.warn('worker push send failed', {
			workerId,
			messageType: message.type,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}
