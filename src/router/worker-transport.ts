/**
 * Worker↔control-plane transport routes — the router's authenticated
 * worker-session surface (ADR-003 §1). A remote `swarm-cli` daemon reaches the
 * same credential→session→heartbeat service the in-process worker uses
 * (`../identity/worker-session-service.ts`), but over the network via the
 * Cloudflare-tunnel-fronted router instead of an in-process call. This module
 * adds no scheduling/eligibility/dispatch behavior: it only keeps the existing
 * `worker_sessions` liveness signal fresh over the wire, which the eligibility
 * gate already consumes.
 *
 * Two routes, both under `/worker`:
 *   - `POST /worker/session` — the handshake (request/response): authenticate the
 *     credential, acquire the fenced lease, declare the daemon's CLIs, return the
 *     session.
 *   - `GET /worker/stream` — a WebSocket carrying periodic heartbeat frames that
 *     keep the lease live, releasing it on disconnect.
 *
 * The request logic is factored out of the socket/HTTP glue into pure,
 * injectable functions (`handleHandshake`, `handleWorkerStreamFrame`) so tests
 * drive them with fake deps and never need a live socket — the same pattern
 * `./webhook-receiver.ts` uses for the webhook surface. Collaborators default to
 * the real session service; tests override them.
 *
 * Credential handling: the raw credential appears only in the handshake body and
 * the stream's `Authorization` header. It is never logged, never placed in a
 * URL, and never reflected in a response body — the same contract
 * `../identity/worker-service.ts` keeps for the persisted credential.
 */

import type { createNodeWebSocket } from '@hono/node-ws';
import type { Hono } from 'hono';
import type { WSContext } from 'hono/ws';

import type { AgentCli } from '../harness/agent-cli.js';
import type { Worker } from '../identity/worker.js';
import {
	refreshWorkerCapabilities,
	resolveWorkerByCredential,
	WorkerCapabilityReductionError,
} from '../identity/worker-service.js';
import {
	type AcquiredSession,
	acquireSession,
	heartbeat,
	releaseSession,
	resolveHeartbeatTtlMs,
	UnknownWorkerCredentialError,
	validateFencingToken,
	WorkerSessionHeldError,
} from '../identity/worker-session-service.js';
import { logger } from '../lib/logger.js';
import {
	type ControlPlaneMessage,
	HandshakeRequestSchema,
	TRANSPORT_PROTOCOL_VERSION,
	WorkerStreamMessageSchema,
	WS_CLOSE,
} from '../transport/protocol.js';

// The application-defined WebSocket close codes are part of the wire contract, so
// they live in the protocol module (the single source of truth for every frame)
// alongside the frame schemas — re-exported here for this module's existing
// consumers/tests.
export { WS_CLOSE };

/** `upgradeWebSocket` handle produced by `createNodeWebSocket` (typed via its return). */
type UpgradeWebSocket = ReturnType<typeof createNodeWebSocket>['upgradeWebSocket'];

/** Human-readable disconnect reason when a heartbeat can no longer refresh the lease. */
const LEASE_LOST_REASON =
	'session lease is no longer live (lost, expired, or superseded by a newer daemon)';

/**
 * Collaborators the transport depends on, defaulted to the real session service
 * so production wiring is a bare `registerWorkerTransport(app, upgradeWebSocket)`;
 * tests inject fakes. Mirrors `WebhookReceiverDeps` in `./webhook-receiver.ts`.
 */
export interface WorkerTransportDeps {
	resolveWorkerByCredential: (rawCredential: string) => Promise<Worker | undefined>;
	acquireSession: (rawCredential: string, ttlMs: number) => Promise<AcquiredSession>;
	heartbeat: (rawCredential: string, fencingToken: number, ttlMs: number) => Promise<boolean>;
	releaseSession: (rawCredential: string, fencingToken: number) => Promise<boolean>;
	refreshWorkerCapabilities: (id: string, capabilities: AgentCli[]) => Promise<Worker | undefined>;
	resolveHeartbeatTtlMs: () => number;
	validateFencingToken: (workerId: string, token: number, ttlMs?: number) => Promise<boolean>;
}

function defaultDeps(): WorkerTransportDeps {
	return {
		resolveWorkerByCredential,
		acquireSession,
		heartbeat,
		releaseSession,
		refreshWorkerCapabilities,
		resolveHeartbeatTtlMs,
		validateFencingToken,
	};
}

/** A handshake outcome: the HTTP status and the JSON body to return. */
export interface HandshakeResult {
	status: 200 | 400 | 401 | 409;
	json: Record<string, unknown>;
}

/**
 * The handshake, as a pure function of its deps and the raw request body:
 * validate → authenticate → acquire lease → declare CLIs → return the session.
 * Returns the status/body for the route to send; never throws for an expected
 * failure (bad request, bad credential, lease held, capability reduction), and
 * never reflects the credential in the body.
 */
export async function handleHandshake(
	deps: WorkerTransportDeps,
	body: unknown,
): Promise<HandshakeResult> {
	const parsed = HandshakeRequestSchema.safeParse(body);
	if (!parsed.success) {
		return { status: 400, json: { authenticated: false, reason: 'invalid handshake request' } };
	}
	const request = parsed.data;

	// A version mismatch is a clean, explicit rejection rather than a frame the
	// two sides would silently misparse later on the stream.
	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION) {
		return {
			status: 400,
			json: {
				authenticated: false,
				reason: 'unsupported protocol version',
				protocolVersion: TRANSPORT_PROTOCOL_VERSION,
			},
		};
	}

	// Authenticate before touching the lease so an unknown credential is a clean
	// 401 (constant-shape body — the credential is never reflected back).
	const worker = await deps.resolveWorkerByCredential(request.credential);
	if (!worker) {
		return { status: 401, json: { authenticated: false } };
	}

	const ttlMs = deps.resolveHeartbeatTtlMs();

	let session: AcquiredSession;
	try {
		session = await deps.acquireSession(request.credential, ttlMs);
	} catch (err) {
		// A live lease already held by another daemon for this worker.
		if (err instanceof WorkerSessionHeldError) {
			return {
				status: 409,
				json: { authenticated: false, reason: 'worker session already held' },
			};
		}
		// Defensive: the credential resolved above, so this should not fire — but a
		// concurrent deletion could make acquire disagree. Treat it as an auth failure.
		if (err instanceof UnknownWorkerCredentialError) {
			return { status: 401, json: { authenticated: false } };
		}
		throw err;
	}

	// Declare the daemon's CLIs only after proving this daemon holds the lease, so
	// a second daemon cannot mutate the roster's capabilities while another owns
	// the session. If the declared set drops a CLI an enrollment needs, release the
	// lease we just took (so a corrected retry isn't blocked by a held session) and
	// report the offending CLIs.
	try {
		await deps.refreshWorkerCapabilities(worker.id, request.capabilities);
	} catch (err) {
		if (err instanceof WorkerCapabilityReductionError) {
			await deps.releaseSession(request.credential, session.fencingToken).catch(() => {});
			return {
				status: 409,
				json: {
					authenticated: false,
					reason: 'declared capabilities drop a CLI an enrollment requires',
					offending: err.offending,
				},
			};
		}
		throw err;
	}

	return {
		status: 200,
		json: {
			authenticated: true,
			workerId: worker.id,
			sessionId: session.session.id,
			fencingToken: session.fencingToken,
			heartbeatTtlMs: ttlMs,
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		},
	};
}

/** Per-connection context threaded into every stream-frame decision. */
export interface WorkerStreamContext {
	/** The raw credential from the upgrade's `Authorization` header. */
	credential: string;
	/** The heartbeat TTL resolved once when the stream opened. */
	ttlMs: number;
	/** The fencing token bound to this WebSocket at upgrade time. */
	fencingToken: number;
}

/**
 * What the socket glue should do with one inbound frame — a pure value so
 * `handleWorkerStreamFrame` is unit-testable without a live socket:
 *   - `ack`        → send `message`, keep the socket open;
 *   - `disconnect` → send `message` (a `disconnect` control frame), then close
 *     with `code`;
 *   - `close`      → close with `code`/`reason`, no frame sent.
 *
 * `ack`/`disconnect` carry the `fencingToken` the frame presented so the socket
 * glue can remember it and release exactly that lease on a graceful close.
 */
export type WorkerStreamAction =
	| { action: 'ack'; fencingToken: number; message: ControlPlaneMessage }
	| { action: 'disconnect'; fencingToken: number; code: number; message: ControlPlaneMessage }
	| { action: 'close'; code: number; reason: string };

/**
 * Decide what to do with one inbound stream frame — pure, so tests drive it with
 * fake deps and a raw string. An unparseable frame closes (4400). A `heartbeat`
 * frame refreshes the lease: a refreshed lease acks; a lease that can no longer
 * be refreshed (lost/expired/superseded) sends a `disconnect` frame and closes
 * (4408).
 */
export async function handleWorkerStreamFrame(
	deps: WorkerTransportDeps,
	ctx: WorkerStreamContext,
	rawFrame: string,
): Promise<WorkerStreamAction> {
	let payload: unknown;
	try {
		payload = JSON.parse(rawFrame);
	} catch {
		return { action: 'close', code: WS_CLOSE.MALFORMED_FRAME, reason: 'malformed frame' };
	}

	const parsed = WorkerStreamMessageSchema.safeParse(payload);
	if (!parsed.success) {
		return { action: 'close', code: WS_CLOSE.MALFORMED_FRAME, reason: 'malformed frame' };
	}

	const frame = parsed.data;
	if (frame.fencingToken !== ctx.fencingToken) {
		return {
			action: 'close',
			code: WS_CLOSE.LEASE_LOST,
			reason: 'fencing token mismatch',
		};
	}
	// Only `heartbeat` exists this phase; the discriminated union guarantees it.
	const refreshed = await deps.heartbeat(ctx.credential, frame.fencingToken, ctx.ttlMs);
	if (!refreshed) {
		return {
			action: 'disconnect',
			fencingToken: frame.fencingToken,
			code: WS_CLOSE.LEASE_LOST,
			message: { type: 'disconnect', reason: LEASE_LOST_REASON },
		};
	}
	return { action: 'ack', fencingToken: frame.fencingToken, message: { type: 'heartbeat-ack' } };
}

/** Extract the raw credential from an `Authorization: Bearer <credential>` header. */
function extractBearerCredential(authorization: string | undefined): string | undefined {
	if (!authorization) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
	return match ? match[1] : undefined;
}

/** Normalize a WebSocket message payload (string or binary) to a string frame. */
function frameToString(data: unknown): string {
	if (typeof data === 'string') return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
	}
	return String(data);
}

/** Apply a {@link WorkerStreamAction} to a live socket. */
function applyStreamAction(ws: WSContext, action: WorkerStreamAction): void {
	switch (action.action) {
		case 'ack':
			ws.send(JSON.stringify(action.message));
			return;
		case 'disconnect':
			ws.send(JSON.stringify(action.message));
			ws.close(action.code, action.message.type === 'disconnect' ? action.message.reason : '');
			return;
		case 'close':
			ws.close(action.code, action.reason);
			return;
	}
}

/**
 * Wire the two transport routes onto the router's Hono `app`. `upgradeWebSocket`
 * is the handle from `createNodeWebSocket({ app })` (constructed in the router
 * entry point so `injectWebSocket` binds the same server). Pass `overrides` to
 * substitute collaborators in tests; omit for production wiring.
 */
export function registerWorkerTransport(
	app: Hono,
	upgradeWebSocket: UpgradeWebSocket,
	overrides: Partial<WorkerTransportDeps> = {},
): void {
	const deps = { ...defaultDeps(), ...overrides };

	app.post('/worker/session', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ authenticated: false, reason: 'invalid handshake request' }, 400);
		}
		const result = await handleHandshake(deps, body);
		return c.json(result.json, result.status);
	});

	async function authenticateUpgrade(
		deps: WorkerTransportDeps,
		credential: string | undefined,
		fencingToken: number,
		ttlMs: number,
	): Promise<boolean> {
		if (!credential || Number.isNaN(fencingToken)) return false;
		try {
			const worker = await deps.resolveWorkerByCredential(credential);
			if (!worker) return false;
			return deps.validateFencingToken(worker.id, fencingToken, ttlMs);
		} catch (err) {
			logger.error('worker transport upgrade authentication failed', {
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	app.get(
		'/worker/stream',
		upgradeWebSocket(async (c) => {
			// Authenticate the upgrade from the bearer credential. The factory runs
			// before the socket opens; an unknown/absent credential yields handlers
			// that close the connection the moment it opens (4401).
			const credential = extractBearerCredential(c.req.header('authorization'));
			const fencingTokenStr = c.req.header('x-fencing-token');
			const fencingToken = fencingTokenStr ? Number.parseInt(fencingTokenStr, 10) : NaN;
			const ttlMs = deps.resolveHeartbeatTtlMs();

			const authenticated = await authenticateUpgrade(deps, credential, fencingToken, ttlMs);
			const safeCredential = credential ?? '';

			return {
				onOpen(_evt, ws) {
					if (!authenticated) {
						ws.close(WS_CLOSE.UNAUTHORIZED, 'unauthorized');
					}
				},
				async onMessage(evt, ws) {
					if (!authenticated) {
						ws.close(WS_CLOSE.UNAUTHORIZED, 'unauthorized');
						return;
					}
					try {
						const action = await handleWorkerStreamFrame(
							deps,
							{ credential: safeCredential, ttlMs, fencingToken },
							frameToString(evt.data),
						);
						applyStreamAction(ws, action);
					} catch (err) {
						logger.error('worker transport stream onMessage failed', {
							error: err instanceof Error ? err.message : String(err),
						});
						ws.close(WS_CLOSE.LEASE_LOST, 'heartbeat processing failed');
					}
				},
				async onClose() {
					// Free the lease promptly on a graceful disconnect rather than waiting
					// out the TTL. An ungraceful drop with no prior heartbeat still expires
					// via the TTL — the existing mechanism. Best-effort: log, don't throw.
					if (!authenticated || !credential) return;
					try {
						await deps.releaseSession(credential, fencingToken);
					} catch (err) {
						logger.warn('worker transport lease release on disconnect failed', {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				},
				onError(evt) {
					logger.warn('worker transport stream error', {
						error: evt instanceof ErrorEvent ? evt.message : String(evt),
					});
				},
			};
		}),
	);
}
