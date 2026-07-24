/**
 * Worker-side transport *dispatch* client — the same-host worker's split-delivery
 * executor (ADR-003 §2). It layers phase execution on top of the DB-free session
 * client (`../transport/worker-client.ts`): that client owns the handshake,
 * heartbeat, and reconnect loop; this module supplies the `onAssignment` handler
 * that runs a pushed `TaskAssignment` and streams the outcome back.
 *
 * Unlike the remote session-only client (`../transport/connect-entry.ts`), this
 * one runs on a host **with** `DATABASE_URL`: it loads the full project config
 * locally (so persona tokens resolve from Postgres exactly as the in-process path
 * does — no secret ever crosses the wire), reuses the same per-phase runner switch
 * (`runAssignedPhase`, `./consumer.ts`) the BullMQ path uses so the two can't
 * diverge, forwards the agent's live output as `StreamLog` frames, and sends a
 * terminal `TaskExecutionResult` mirroring the in-process `JobOutcome` so the
 * control plane can settle the dispatch.
 *
 * It is gated behind a default-off dispatch mode (`SWARM_DISPATCH_MODE`,
 * `../lib/env.ts`): when off, `./index.ts` runs the BullMQ consumer exactly as
 * today; when on, it runs this client instead. Until phase 4 wires the
 * control-plane sending side, this is dead-but-tested code.
 */

import type { ProjectConfig } from '../config/schema.js';
import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import type { AgentCli } from '../harness/agent-cli.js';
import { AgentRunError, agentRunError } from '../harness/agent-failure.js';
import { describeError } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { phaseLabel } from '../pipeline/phase-label.js';
import type { WorkItem } from '../pm/types.js';
import {
	clearRunCancellation,
	isRunCancellationRequested,
	RUN_CANCELLED_MESSAGE,
} from '../queue/cancellation.js';
import { DeliveryDeferredError } from '../scm/delivery.js';
import type {
	AssignedWorkItem,
	StreamLogLine,
	TaskAssignment,
	TaskExecutionResult,
} from '../transport/protocol.js';
import {
	type AssignmentSink,
	type BackoffConfig,
	connectWorkerTransport,
	type TransportLogger,
	type WorkerTransportClient,
} from '../transport/worker-client.js';
import {
	type AssignedPhaseInputs,
	type DeferrableFailure,
	type PhaseRunResult,
	retryDelayForFailure,
	runAssignedPhase,
} from './consumer.js';
import { createLiveOutputRunner } from './live-output.js';
import {
	beginRunCancellationTracking,
	linkRunAbortController,
	unregisterRunController,
} from './run-cancellation.js';

/** Batch window/size for forwarded output — mirrors `./live-output.ts`. */
const BATCH_MS = 100;
const BATCH_SIZE = 100;

/**
 * Collaborators the assignment executor resolves per phase. Defaulted to the real
 * DB lookup and the shared phase-runner switch; a unit test injects fakes so it
 * can drive succeeded/deferred/failed settlements without a database or a real
 * agent CLI.
 */
export interface AssignmentDeps {
	/** Load the FULL project config (with credentials) so persona tokens resolve locally. */
	loadProject: (id: string) => Promise<ProjectConfig | undefined>;
	/** The shared per-phase runner switch (`./consumer.ts`). */
	runPhase: (inputs: AssignedPhaseInputs) => Promise<PhaseRunResult>;
	logger: TransportLogger;
}

function resolveAssignmentDeps(overrides: Partial<AssignmentDeps> = {}): AssignmentDeps {
	return {
		loadProject: overrides.loadProject ?? findProjectByIdFromDb,
		runPhase: overrides.runPhase ?? runAssignedPhase,
		logger: overrides.logger ?? defaultLogger,
	};
}

/** Map the transport's serialization subset back to a PM `WorkItem` for the phase runner. */
export function fromAssignedWorkItem(item: AssignedWorkItem): WorkItem {
	return {
		id: item.id,
		title: item.title,
		description: item.description,
		url: item.url,
		status: item.status,
		statusId: item.statusId,
		labels: item.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
		assignees: item.assignees.map((assignee) => ({
			handle: assignee.handle,
			displayName: assignee.displayName,
			providerId: assignee.providerId,
		})),
	};
}

/**
 * Wrap the agent runner so every emitted line is forwarded to the control plane
 * as a batched `StreamLog` frame — the transport analogue of `./live-output.ts`'s
 * DB batcher, which `base` still performs (it persists to `run_output_events`
 * when the assignment carries a run id, since this worker is same-host with DB
 * access). `base` is injectable so a test can drive the forwarding without a real
 * CLI.
 */
export function createAssignmentRunAgent(
	assignment: TaskAssignment,
	sink: AssignmentSink,
	base: ReturnType<typeof createLiveOutputRunner> = createLiveOutputRunner(assignment.runId),
): ReturnType<typeof createLiveOutputRunner> {
	return async (options) => {
		let queue: StreamLogLine[] = [];
		let timer: ReturnType<typeof setTimeout> | undefined;
		const flush = (): void => {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			const batch = queue;
			queue = [];
			const [first, ...rest] = batch;
			if (!first) return;
			sink.send({
				type: 'stream-log',
				dispatchId: assignment.dispatchId,
				runId: assignment.runId,
				lines: [first, ...rest],
			});
		};
		const enqueue = (stream: 'stdout' | 'stderr', line: string): void => {
			queue.push({ stream, content: `${line}\n`, emittedAt: new Date().toISOString() });
			if (queue.length >= BATCH_SIZE) flush();
			else timer ??= setTimeout(flush, BATCH_MS);
		};
		try {
			return await base({
				...options,
				onStdout: (line) => {
					options.onStdout?.(line);
					enqueue('stdout', line);
				},
				onStderr: (line) => {
					options.onStderr?.(line);
					enqueue('stderr', line);
				},
			});
		} finally {
			// Flush whatever the run produced before it settled, even on the throwing
			// paths — the same "preserve the last output" contract `./live-output.ts` keeps.
			flush();
		}
	};
}

/** Assemble the normalized phase inputs from a pushed assignment + the locally-loaded project. */
function buildAssignedPhaseInputs(
	assignment: TaskAssignment,
	project: ProjectConfig,
	signal: AbortSignal,
	sink: AssignmentSink,
): AssignedPhaseInputs {
	return {
		phase: assignment.phase,
		taskId: assignment.taskId,
		project,
		cli: assignment.target.cli,
		model: assignment.target.model,
		reasoning: assignment.target.reasoning,
		customPrompt: assignment.customPrompt,
		timeoutMs: assignment.timeoutMs,
		sessionId: assignment.resumeSession ? undefined : assignment.agentSessionId,
		resumeSessionId: assignment.resumeSession ? assignment.agentSessionId : undefined,
		resumeDelivery: assignment.resumeDelivery === true,
		runId: assignment.runId,
		signal,
		runAgent: createAssignmentRunAgent(assignment, sink),
		workItem: assignment.workItem ? fromAssignedWorkItem(assignment.workItem) : undefined,
		resumeExistingBranch: assignment.implementationBranchProvisioned === true,
		// Report the branch checkpoint so the control plane can persist
		// `implementationBranchProvisioned` for a resumed re-push (idempotency).
		onBranchProvisioned: async () => {
			sink.send({
				type: 'task-progress',
				dispatchId: assignment.dispatchId,
				runId: assignment.runId,
				phase: assignment.phase,
				taskId: assignment.taskId,
				state: 'branch-provisioned',
			});
		},
		prNumber: assignment.prNumber,
		prBranch: assignment.prBranch,
		headSha: assignment.headSha,
		reviewId: assignment.reviewId,
		baseBranch: assignment.baseBranch,
		baseSha: assignment.baseSha,
	};
}

/**
 * Classify a phase failure into the deferrable failure the control plane should
 * schedule a retry for, or `undefined` for a terminal failure — the exact rule
 * the in-process `handlePhaseFailure` applies (`./consumer.ts`): a rate-limit,
 * capacity, aborted, or stalled agent error, a genuinely-interrupted timeout
 * (non-zero/absent exit — a clean SIGTERM exit already cleaned up), or a
 * deterministic-delivery deferral.
 */
function classifyDeferrable(err: unknown): DeferrableFailure | undefined {
	if (err instanceof DeliveryDeferredError) return { kind: 'delivery' };
	if (err instanceof AgentRunError) {
		const kind = err.failure.kind;
		if (kind === 'rate-limit' || kind === 'capacity' || kind === 'aborted' || kind === 'stalled') {
			return err.failure;
		}
		if (kind === 'timeout' && err.agent !== undefined && err.agent.exitCode !== 0) {
			return err.failure;
		}
	}
	return undefined;
}

/** Build the terminal `succeeded` result frame from a completed phase run. */
function succeededResult(assignment: TaskAssignment, result: PhaseRunResult): TaskExecutionResult {
	return {
		type: 'task-execution-result',
		dispatchId: assignment.dispatchId,
		runId: assignment.runId,
		status: 'succeeded',
		phase: assignment.phase,
		taskId: assignment.taskId,
		exitCode: result.agent.exitCode,
		signal: result.agent.signal,
		timedOut: result.agent.timedOut,
		durationMs: result.agent.durationMs,
		// The terminal PM/verdict context the control plane settles on (issue #407):
		// a PM-driven phase's auto-advance status drives the next phase's
		// self-enqueue on the control plane; a Review run's verdict/ordinal/outcome
		// are persisted on its run row and gate merge automation. Absent for phases
		// that produce none.
		movedTo: result.movedTo,
		verdict: result.verdict,
		reviewOrdinal: result.reviewOrdinal,
		reviewAutomationOutcome: result.automationOutcome,
	};
}

/**
 * Build the terminal failure/deferral result frame. A user termination (issue
 * #166) settles terminal-`failed` with `cancelled: true` (never deferred, which
 * would re-run the very phase the user killed); a deferrable failure settles
 * `deferred` with the retry hint + resume flags a `phase-deferred` outcome
 * carries; everything else settles terminal-`failed`.
 */
async function settleFailure(
	err: unknown,
	assignment: TaskAssignment,
): Promise<TaskExecutionResult> {
	const error = describeError(err);
	const terminal = {
		type: 'task-execution-result' as const,
		dispatchId: assignment.dispatchId,
		runId: assignment.runId,
		phase: assignment.phase,
		taskId: assignment.taskId,
	};
	if (assignment.runId && (await isRunCancellationRequested(assignment.runId))) {
		return { ...terminal, status: 'failed', error: RUN_CANCELLED_MESSAGE, cancelled: true };
	}
	const failure = classifyDeferrable(err);
	if (failure) {
		return {
			...terminal,
			status: 'deferred',
			retryDelayMs: retryDelayForFailure(failure, Date.now()),
			resumable:
				failure.kind === 'rate-limit' || failure.kind === 'timeout' || failure.kind === 'stalled',
			resumeDelivery: failure.kind === 'delivery' || undefined,
			failureKind: failure.kind,
			reason: error,
		};
	}
	return { ...terminal, status: 'failed', error };
}

/** Options {@link runAssignment} reads — a shared in-flight set, the shutdown signal, and its deps. */
export interface RunAssignmentOptions {
	/** Dedup set keyed by `dispatchId`, shared across every assignment on the session. */
	inFlight?: Set<string>;
	/** Worker shutdown signal — aborting kills the in-flight agent CLI. */
	shutdownSignal?: AbortSignal;
	/** Collaborators (defaulted to the real DB lookup + shared phase runner). */
	deps?: Partial<AssignmentDeps>;
}

/**
 * Execute one pushed `TaskAssignment` and stream its lifecycle back through the
 * sink: an immediate ack (marking a re-pushed dispatch a duplicate so the control
 * plane drops it), a `running` progress marker, batched live output, and a
 * terminal `TaskExecutionResult`. Idempotent by `dispatchId`: a re-pushed
 * assignment for a dispatch already running here keeps the in-flight run rather
 * than starting a second (ADR-003 §2). Never throws — every settlement is a frame.
 */
export async function runAssignment(
	assignment: TaskAssignment,
	sink: AssignmentSink,
	options: RunAssignmentOptions = {},
): Promise<void> {
	const deps = resolveAssignmentDeps(options.deps);
	const inFlight = options.inFlight ?? new Set<string>();
	const { dispatchId, runId, phase, taskId } = assignment;

	const duplicate = inFlight.has(dispatchId);
	sink.send({ type: 'task-assignment-ack', dispatchId, runId, duplicate });
	if (duplicate) {
		deps.logger.info('ignoring re-pushed assignment already running here', { dispatchId, taskId });
		return;
	}
	inFlight.add(dispatchId);

	const { controller, detach } = linkRunAbortController(options.shutdownSignal);
	try {
		const project = await deps.loadProject(assignment.projectConfig.id);
		if (!project) {
			sink.send({
				type: 'task-execution-result',
				dispatchId,
				runId,
				status: 'failed',
				phase,
				taskId,
				error: `Assignment references unknown project '${assignment.projectConfig.id}'`,
			});
			return;
		}

		// Make the run cancellable by id and honour a cancellation already recorded
		// (a re-push whose run the operator terminated meanwhile).
		await beginRunCancellationTracking(runId, controller);

		sink.send({ type: 'task-progress', dispatchId, runId, phase, taskId, state: 'running' });

		const inputs = buildAssignedPhaseInputs(assignment, project, controller.signal, sink);
		const result = await deps.runPhase(inputs);
		// A run the harness killed for exceeding its wall-clock timeout is a terminal
		// failure even if the agent trapped SIGTERM and still exited 0 (issue #165) —
		// route it through the failure path like the in-process `processJob` does.
		if (result.agent.timedOut) {
			throw agentRunError(
				result.agent,
				`${phaseLabel(phase)} agent exceeded its wall-clock timeout`,
				` for task '${taskId}'`,
			);
		}
		sink.send(succeededResult(assignment, result));
	} catch (err) {
		deps.logger.warn('assignment phase failed', {
			dispatchId,
			phase,
			taskId,
			error: describeError(err),
		});
		sink.send(await settleFailure(err, assignment));
	} finally {
		detach();
		if (runId) {
			unregisterRunController(runId);
			await clearRunCancellation(runId).catch(() => {});
		}
		inFlight.delete(dispatchId);
	}
}

/** Options for {@link startWorkerTransportDispatch}. */
export interface WorkerTransportDispatchOptions {
	controlPlaneUrl: string;
	credential: string;
	capabilities: AgentCli[];
	hostname: string;
	daemonVersion: string;
	/** Worker shutdown signal — aborting kills any in-flight agent CLI. */
	shutdownSignal?: AbortSignal;
	/** Reconnect backoff overrides. */
	backoff?: Partial<BackoffConfig>;
}

/**
 * Start the same-host transport-dispatch client: it keeps an authenticated
 * session live and, on each pushed `TaskAssignment`, runs the phase locally and
 * streams the result back. Returns the {@link WorkerTransportClient} handle so
 * `./index.ts` can await `done` and `stop()` it on shutdown. The `inFlight` set
 * is shared across every assignment on the client for cross-assignment idempotency.
 */
export function startWorkerTransportDispatch(
	options: WorkerTransportDispatchOptions,
	deps: Partial<AssignmentDeps> = {},
): WorkerTransportClient {
	const resolved = resolveAssignmentDeps(deps);
	const inFlight = new Set<string>();
	return connectWorkerTransport({
		controlPlaneUrl: options.controlPlaneUrl,
		credential: options.credential,
		capabilities: options.capabilities,
		hostname: options.hostname,
		daemonVersion: options.daemonVersion,
		backoff: options.backoff,
		onAssignment: (assignment, sink) => {
			void runAssignment(assignment, sink, {
				inFlight,
				shutdownSignal: options.shutdownSignal,
				deps: resolved,
			});
		},
	});
}
