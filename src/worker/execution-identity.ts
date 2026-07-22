import {
	acquireSession,
	heartbeat,
	releaseSession,
	resolveHeartbeatTtlMs,
} from '../identity/worker-session-service.js';

/** Authenticated worker-host identity threaded through every federated dispatch attempt. */
export interface WorkerExecutionIdentity {
	workerId: string;
	sessionId: string;
	fencingToken: number;
	heartbeatTtlMs: number;
}

/** A live worker session owned by this process; the raw credential never leaves this handle. */
export interface WorkerExecutionSession {
	identity: WorkerExecutionIdentity;
	heartbeat(): Promise<boolean>;
	release(): Promise<boolean>;
}

/** Authenticate this host and acquire its single fenced worker-session lease. */
export async function acquireWorkerExecutionSession(
	rawCredential: string,
): Promise<WorkerExecutionSession> {
	const heartbeatTtlMs = resolveHeartbeatTtlMs();
	const acquired = await acquireSession(rawCredential, heartbeatTtlMs);
	const identity: WorkerExecutionIdentity = {
		workerId: acquired.session.workerId,
		sessionId: acquired.session.id,
		fencingToken: acquired.fencingToken,
		heartbeatTtlMs,
	};
	return {
		identity,
		heartbeat: () => heartbeat(rawCredential, identity.fencingToken, heartbeatTtlMs),
		release: () => releaseSession(rawCredential, identity.fencingToken),
	};
}
