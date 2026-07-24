import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { registerWorker } from '../../../src/identity/worker-service.js';
import { getLiveSessionForWorker } from '../../../src/identity/worker-session-service.js';
import { registerWorkerTransport } from '../../../src/router/worker-transport.js';
import { TRANSPORT_PROTOCOL_VERSION } from '../../../src/transport/protocol.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

/** Short heartbeat TTL so a stopped heartbeat expires the lease within the test. */
const TTL_MS = 500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stand up the real router transport on an ephemeral port; returns base URLs + teardown. */
async function startTransport() {
	const app = new Hono();
	const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
	registerWorkerTransport(app, upgradeWebSocket);
	const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
		const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
	});
	injectWebSocket(server);
	const { port } = server.address() as AddressInfo;
	return {
		httpBase: `http://127.0.0.1:${port}`,
		wsBase: `ws://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** Open a WS carrying the bearer credential and resolve once it is open. */
function openStream(wsBase: string, credential: string): Promise<WebSocket> {
	const ws = new WebSocket(`${wsBase}/worker/stream`, {
		headers: { authorization: `Bearer ${credential}` },
	});
	return new Promise((resolve, reject) => {
		ws.once('open', () => resolve(ws));
		ws.once('error', reject);
	});
}

/** Resolve the next text message a socket receives. */
function nextMessage(ws: WebSocket): Promise<string> {
	return new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())));
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'worker transport over WS (integration)',
	() => {
		let transport: Awaited<ReturnType<typeof startTransport>>;
		let credential: string;
		let workerId: string;
		const originalTtl = process.env.SWARM_WORKER_HEARTBEAT_TTL_MS;

		beforeEach(async () => {
			process.env.SWARM_WORKER_HEARTBEAT_TTL_MS = String(TTL_MS);
			await truncateAll();
			await seedProject({ id: 'proj-worker-transport', repo: 'jkwiecien/worker-transport-repo' });
			const owner = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
			const registered = await registerWorker({
				ownerUserId: owner.id,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
			});
			credential = registered.credential;
			workerId = registered.worker.id;
			transport = await startTransport();
		});

		afterEach(async () => {
			await transport.close();
			if (originalTtl === undefined) delete process.env.SWARM_WORKER_HEARTBEAT_TTL_MS;
			else process.env.SWARM_WORKER_HEARTBEAT_TTL_MS = originalTtl;
		});

		async function handshake() {
			const res = await fetch(`${transport.httpBase}/worker/session`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					credential,
					daemonVersion: '1.0.0',
					hostname: 'ada-laptop',
					capabilities: ['claude'],
					protocolVersion: TRANSPORT_PROTOCOL_VERSION,
				}),
			});
			return { status: res.status, body: (await res.json()) as Record<string, unknown> };
		}

		it('handshakes, keeps the lease live via heartbeats, and expires it once they stop', async () => {
			const { status, body } = await handshake();
			expect(status).toBe(200);
			expect(body).toMatchObject({ authenticated: true, workerId });
			const fencingToken = body.fencingToken as number;

			// A live session exists straight after the handshake acquired the lease.
			expect(await getLiveSessionForWorker(workerId, TTL_MS)).toBeDefined();

			// A heartbeat over the stream is acked and refreshes the lease.
			const ws = await openStream(transport.wsBase, credential);
			try {
				const ack = nextMessage(ws);
				ws.send(JSON.stringify({ type: 'heartbeat', fencingToken }));
				expect(JSON.parse(await ack)).toEqual({ type: 'heartbeat-ack' });
				expect(await getLiveSessionForWorker(workerId, TTL_MS)).toBeDefined();
			} finally {
				ws.close();
			}

			// Stop heartbeating: past the TTL the lease is no longer live — the exact
			// signal the eligibility gate consumes to drop a disconnected worker.
			await sleep(TTL_MS + 200);
			expect(await getLiveSessionForWorker(workerId, TTL_MS)).toBeUndefined();
		});

		it('refuses the stream upgrade for an unknown credential', async () => {
			const ws = new WebSocket(`${transport.wsBase}/worker/stream`, {
				headers: { authorization: 'Bearer not-a-real-credential' },
			});
			const closeCode = await new Promise<number>((resolve, reject) => {
				ws.once('close', (code) => resolve(code));
				ws.once('error', reject);
			});
			expect(closeCode).toBe(4401);
		});
	},
);
