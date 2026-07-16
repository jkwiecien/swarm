/**
 * Keep an offline worker from replaying old webhook intent. BullMQ records the
 * enqueue timestamp independently of job payload data, so this also covers
 * delayed retries and cannot be changed by a webhook body.
 */
export const DEFAULT_MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;

export function resolveMaxJobAgeMs(raw = process.env.SWARM_MAX_JOB_AGE_MS): number {
	if (raw === undefined || raw === '') return DEFAULT_MAX_JOB_AGE_MS;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`SWARM_MAX_JOB_AGE_MS must be a positive integer, got '${raw}'`);
	}
	return value;
}

export function isJobStale(timestampMs: number, maxAgeMs: number, nowMs = Date.now()): boolean {
	return nowMs - timestampMs > maxAgeMs;
}
