/**
 * Mirrors the server `workers.list` contract (`listDashboardWorkers`,
 * `src/identity/worker-enrollment-service.ts`, issue #133). The web package
 * doesn't import server modules, so this re-declares the shape here the same way
 * `RunRow` (`./runs.ts`) hand-mirrors the runs row — keep it in step with the
 * service's `DashboardWorkerView`.
 *
 * Everything here is read-only and secret-free by construction on the server: no
 * machine path, credential, token, allowed-CLI constraint, or approval control
 * crosses the wire, so the screen has nothing operable to render.
 */

/** Whether the worker's lease is live under the heartbeat TTL right now. */
export type WorkerConnectionState = 'online' | 'offline';

/** The enrollment/approval state of a worker in one project the viewer may see. */
export type WorkerEnrollmentStatus = 'pending' | 'active' | 'suspended';

export interface WorkerEnrollmentSummary {
	projectId: string;
	status: WorkerEnrollmentStatus;
}

/** The owner shown beside a worker — a non-secret identity, never a credential. */
export interface WorkerOwner {
	userId: string;
	identifier: string;
	displayName: string;
}

export interface WorkerRow {
	workerId: string;
	displayName: string;
	owner: WorkerOwner | null;
	/** Declared agent CLIs (`claude` | `antigravity` | `codex`). */
	capabilities: string[];
	connection: WorkerConnectionState;
	/** ISO 8601 — when the worker was last heard from; null if it never connected. */
	lastSeenAt: string | null;
	/** The run it is executing right now; null when idle or the run is out of scope. */
	currentRunId: string | null;
	/** Only enrollments in projects the viewer may access; empty for an un-enrolled machine. */
	enrollments: WorkerEnrollmentSummary[];
}
