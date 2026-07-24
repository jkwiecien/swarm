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
 * The session subset (ADR-003 §1) stands up an authenticated session and keeps
 * its `worker_sessions` lease live: handshake in both directions, plus the
 * heartbeat/ack/disconnect control frames. Split delivery (ADR-003 §2) then
 * adds the `TaskAssignment` cloud→worker frame below; the back-channel frames it
 * pairs with — `TaskExecutionResult` / `StreamLog` (PROJECT.md §3) — join the
 * worker→cloud union in a later split-delivery slice and are absent here.
 *
 * Capabilities are the harness's `AgentCli` vocabulary
 * (`../harness/agent-cli.ts`), never a parallel CLI enum — the same rule the
 * worker identity follows (`../identity/worker.ts`).
 */

import { z } from 'zod';
import { NonSecretProjectConfigSchema } from '../config/project-config-slice.js';
import { AgentTargetSchema } from '../config/schema.js';
import { AgentCliSchema } from '../harness/agent-cli.js';
import type { TriggerPhase } from '../triggers/types.js';

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
 * The worker-runnable pipeline phases, keyed so the object literal must name
 * *exactly* the `TriggerPhase` members (`../triggers/types.ts`): a missing phase
 * or an extra one both fail to type-check here, so this transport enum and the
 * pipeline's phase union can never drift apart. Consumed by `TaskPhaseSchema`
 * below (via `Object.keys`), so it is not dead code.
 */
const TASK_PHASE_KEYS: Record<TriggerPhase, true> = {
	planning: true,
	implementation: true,
	review: true,
	'respond-to-review': true,
	'respond-to-ci': true,
	'resolve-conflicts': true,
};

/** The transport's Zod mirror of `TriggerPhase`, built from the parity map above. */
export const TaskPhaseSchema = z.enum(
	Object.keys(TASK_PHASE_KEYS) as [TriggerPhase, ...TriggerPhase[]],
);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

/**
 * The transport's serialization view of a PM `WorkItem` (`../pm/types.ts`) — the
 * fields a planning/implementation phase reads on the worker, as a Zod schema (a
 * `WorkItem` is a plain interface, so it has no schema of its own). Deliberately
 * a tight subset: a field a future phase needs on the worker must be added here
 * too. Nothing on a `WorkItem` is secret, so this drops nothing sensitive.
 */
export const AssignedWorkItemSchema = z.object({
	id: z.string().min(1),
	title: z.string(),
	description: z.string(),
	url: z.string(),
	status: z.string().optional(),
	statusId: z.string().optional(),
	labels: z.array(z.object({ id: z.string(), name: z.string(), color: z.string().optional() })),
	assignees: z.array(
		z.object({
			handle: z.string(),
			displayName: z.string().optional(),
			providerId: z.string().optional(),
		}),
	),
});
export type AssignedWorkItem = z.infer<typeof AssignedWorkItemSchema>;

/**
 * Cloud→worker frame assigning one pipeline phase to a connected worker. It
 * carries everything the worker's phase runner needs to execute and settle the
 * dispatch idempotently: the work-item payload (or PR coordinates, per phase),
 * the already-resolved target branch, the already-composed system prompt, the
 * routing `target`, and the NON-SECRET project-config slice — never a persona
 * token or a credential reference.
 *
 * The secret boundary is enforced by the builder (`./assignment.ts`), which
 * derives `projectConfig` from the full config itself; this schema simply types
 * the wire shape. `targetBranch` and `systemPrompt` arrive already computed (the
 * control plane composes them — phase 4), so this frame is a pure data carrier.
 */
export const TaskAssignmentSchema = z.object({
	type: z.literal('task-assignment'),
	protocolVersion: z.number().int(),
	dispatchId: z.string().uuid(),
	runId: z.string().uuid().optional(),
	phase: TaskPhaseSchema,
	taskId: z.string().min(1),
	projectConfig: NonSecretProjectConfigSchema,
	targetBranch: z.string().min(1),
	systemPrompt: z.string().min(1),
	customPrompt: z.string().optional(),
	target: AgentTargetSchema,
	timeoutMs: z.number().int().positive().optional(),
	// Session threading / resume — mirrors the `session` object `runPhase`
	// assembles and the resume fields on `SwarmJob` (`src/worker/consumer.ts`).
	agentSessionId: z.string().optional(),
	resumeSession: z.boolean().optional(),
	resumeDelivery: z.boolean().optional(),
	implementationBranchProvisioned: z.boolean().optional(),
	// Phase-specific inputs — mirror `TriggerResult` (`src/triggers/types.ts`):
	// planning/implementation carry `workItem`; the PR phases carry the PR
	// coordinates, with `reviewId` only for respond-to-review and
	// `baseBranch`/`baseSha` only for resolve-conflicts.
	workItem: AssignedWorkItemSchema.optional(),
	prNumber: z.string().optional(),
	prBranch: z.string().optional(),
	headSha: z.string().optional(),
	reviewId: z.string().optional(),
	baseBranch: z.string().optional(),
	baseSha: z.string().optional(),
});
export type TaskAssignment = z.infer<typeof TaskAssignmentSchema>;

/**
 * Every worker→cloud stream frame, discriminated on `type`. Only `heartbeat`
 * exists this phase; `TaskExecutionResult`/`StreamLog` (PROJECT.md §3) join here
 * in the split-delivery phase (ADR-003 §2).
 */
export const WorkerStreamMessageSchema = z.discriminatedUnion('type', [HeartbeatSchema]);
export type WorkerStreamMessage = z.infer<typeof WorkerStreamMessageSchema>;

/**
 * Every cloud→worker stream frame, discriminated on `type`: the lease-liveness
 * control frames plus `TaskAssignment` (PROJECT.md §3), which lands here in the
 * split-delivery phase (ADR-003 §2). The back-channel frames it depends on —
 * `TaskExecutionResult`/`StreamLog` on the worker→cloud union above — remain
 * later split-delivery work.
 */
export const ControlPlaneMessageSchema = z.discriminatedUnion('type', [
	HeartbeatAckSchema,
	DisconnectSchema,
	TaskAssignmentSchema,
]);
export type ControlPlaneMessage = z.infer<typeof ControlPlaneMessageSchema>;
