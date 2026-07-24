/**
 * Wire protocol for the authenticated worker↔control-plane transport — the Zod
 * schemas that are the single source of truth for every frame crossing the
 * network (ai/CODING_STANDARDS.md "Zod is the source of truth"). The MVP carries
 * these over HTTP (the handshake, request/response) and a WebSocket (the
 * heartbeat stream) instead of the future gRPC pipe (PROJECT.md §3), but the
 * message *names* track that spec's `AgentMessage`/`CloudMessage` payloads —
 * `HandshakeRequest`/`HandshakeResponse`/`Heartbeat` — so a later gRPC engine can
 * adopt the same vocabulary without renaming.
 *
 * This phase (ADR-003 §1) defines only the subset the transport needs to stand
 * up an authenticated session and keep its `worker_sessions` lease live:
 * handshake in both directions, plus the heartbeat/ack/disconnect control
 * frames. The split-delivery frames — `TaskAssignment` / `TaskExecutionResult` /
 * `StreamLog` (PROJECT.md §3) — join the two unions below in the split-delivery
 * phase (ADR-003 §2); they are deliberately absent here.
 *
 * Capabilities are the harness's `AgentCli` vocabulary
 * (`../harness/agent-cli.ts`), never a parallel CLI enum — the same rule the
 * worker identity follows (`../identity/worker.ts`).
 */

import { z } from 'zod';

import { AgentCliSchema } from '../harness/agent-cli.js';

/**
 * Transport protocol version, sent in both handshake directions. A mismatch is
 * rejected cleanly at the handshake (a distinct 400) rather than left to surface
 * as a silent misparse of a frame shape the other side doesn't share. Bump this
 * whenever a frame shape changes incompatibly.
 */
export const TRANSPORT_PROTOCOL_VERSION = 1;

/**
 * Optional, best-effort host-health telemetry a worker may attach to a
 * heartbeat — the transport equivalent of PROJECT.md §3's `Heartbeat` fields.
 * Purely advisory for now (nothing in this phase consumes it); every field is
 * optional so an older/leaner daemon can heartbeat without reporting any.
 */
export const WorkerHealthSchema = z.object({
	/** Recent CPU load as a percentage in [0, 100]. */
	cpuLoadPercent: z.number().min(0).max(100).optional(),
	/** Available RAM in bytes. */
	availableRamBytes: z.number().int().nonnegative().optional(),
});
export type WorkerHealth = z.infer<typeof WorkerHealthSchema>;

/**
 * `POST /worker/session` request body — the handshake that opens an authenticated
 * session. The raw `credential` authenticates the worker against the roster
 * (never logged, never echoed back); `capabilities` is the CLI set the daemon
 * declares it can run, applied to the worker on connect. `daemonVersion` and
 * `hostname` are diagnostic. Connect-time health is implicit in a successful
 * handshake; ongoing health rides the heartbeat.
 */
export const HandshakeRequestSchema = z.object({
	credential: z.string().min(1),
	daemonVersion: z.string().min(1),
	hostname: z.string().min(1),
	capabilities: z.array(AgentCliSchema).nonempty(),
	protocolVersion: z.number().int(),
});
export type HandshakeRequest = z.infer<typeof HandshakeRequestSchema>;

/**
 * `POST /worker/session` success body. Carries the acquired lease's identifiers
 * — `sessionId` and the `fencingToken` the daemon must present on every
 * subsequent heartbeat — plus the `heartbeatTtlMs` that governs how long the
 * lease stays live between heartbeats. A failed handshake never uses this shape;
 * it returns a constant-shape error body (see `../router/worker-transport.ts`)
 * that never reflects the credential.
 */
export const HandshakeResponseSchema = z.object({
	authenticated: z.literal(true),
	workerId: z.string().uuid(),
	sessionId: z.string().uuid(),
	fencingToken: z.number().int().positive(),
	heartbeatTtlMs: z.number().int().positive(),
	protocolVersion: z.number().int(),
});
export type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;

/**
 * Worker→cloud heartbeat frame carried on `GET /worker/stream`. Presents the
 * `fencingToken` from the handshake so the control plane refreshes only the
 * lease this daemon actually holds; a stale/superseded token refreshes nothing.
 * `health` is optional advisory telemetry.
 */
export const HeartbeatSchema = z.object({
	type: z.literal('heartbeat'),
	fencingToken: z.number().int().positive(),
	health: WorkerHealthSchema.optional(),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

/** Cloud→worker acknowledgement that a heartbeat refreshed the live lease. */
export const HeartbeatAckSchema = z.object({
	type: z.literal('heartbeat-ack'),
});
export type HeartbeatAck = z.infer<typeof HeartbeatAckSchema>;

/**
 * Cloud→worker control frame telling the daemon its session is over — sent just
 * before the socket closes when a heartbeat cannot refresh the lease (it was
 * lost, expired, or superseded by a newer daemon). `reason` is human-readable
 * for the daemon's log; it never carries the credential.
 */
export const DisconnectSchema = z.object({
	type: z.literal('disconnect'),
	reason: z.string(),
});
export type Disconnect = z.infer<typeof DisconnectSchema>;

/**
 * Every worker→cloud stream frame, discriminated on `type`. Only `heartbeat`
 * exists this phase; `TaskExecutionResult`/`StreamLog` (PROJECT.md §3) join here
 * in the split-delivery phase (ADR-003 §2).
 */
export const WorkerStreamMessageSchema = z.discriminatedUnion('type', [HeartbeatSchema]);
export type WorkerStreamMessage = z.infer<typeof WorkerStreamMessageSchema>;

/**
 * Every cloud→worker stream frame, discriminated on `type`. Only the
 * lease-liveness control frames exist this phase; `TaskAssignment` (PROJECT.md
 * §3) joins here in the split-delivery phase (ADR-003 §2).
 */
export const ControlPlaneMessageSchema = z.discriminatedUnion('type', [
	HeartbeatAckSchema,
	DisconnectSchema,
]);
export type ControlPlaneMessage = z.infer<typeof ControlPlaneMessageSchema>;

/**
 * Control-plane SCM metadata delivery frames (ADR-002 §2). The metadata-only
 * SCM delivery calls — submit a review, post a PR comment — move server-side so
 * the per-project reviewer PAT stays on the router and never reaches a worker: a
 * federated worker sends only the verdict + comment body + PR number up the
 * transport, and the router performs the GitHub write under that PAT (the review
 * still lands as a genuine GitHub review, keeping the `pull_request_review`
 * respond-to-review trigger working — PROJECT.md §5.4).
 *
 * These are **HTTP request/response** frames — carried by the router's
 * `POST /worker/delivery/*` routes exactly as the handshake rides
 * `POST /worker/session` — so they are deliberately *not* added to the WebSocket
 * `WorkerStreamMessageSchema`/`ControlPlaneMessageSchema` unions above (those
 * stay the handshake/heartbeat control stream). The fields carry no GitHub
 * vocabulary (ai/RULES.md §2) so a second SCM provider can reuse the same wire.
 * `protocolVersion` handshakes exactly as the session handshake does: a mismatch
 * is a clean 400 rather than a silent misparse.
 */
export const SubmitReviewDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	prNumber: z.number().int().positive(),
	verdict: z.enum(['approve', 'request-changes', 'comment']),
	body: z.string().min(1),
	deliveryId: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type SubmitReviewDeliveryRequest = z.infer<typeof SubmitReviewDeliveryRequestSchema>;

/** `POST /worker/delivery/review` success body — the created review's id. */
export const SubmitReviewDeliveryResponseSchema = z.object({
	reviewId: z.number().int().positive(),
});
export type SubmitReviewDeliveryResponse = z.infer<typeof SubmitReviewDeliveryResponseSchema>;

/** `POST /worker/delivery/pr-comment` request body — a top-level PR comment. */
export const PostCommentDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	prNumber: z.number().int().positive(),
	body: z.string().min(1),
	deliveryId: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type PostCommentDeliveryRequest = z.infer<typeof PostCommentDeliveryRequestSchema>;

/** `POST /worker/delivery/pr-comment` success body — the created comment's id. */
export const PostCommentDeliveryResponseSchema = z.object({
	commentId: z.number().int().positive(),
});
export type PostCommentDeliveryResponse = z.infer<typeof PostCommentDeliveryResponseSchema>;
