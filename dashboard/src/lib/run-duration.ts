import { useEffect, useState } from 'react';

export const LIVE_DURATION_TICK_MS = 1000;

interface RunDurationInput {
	status: string;
	startedAt: string | null | undefined;
	completedAt: string | null | undefined;
	durationMs: number | null | undefined;
}

function parseTimestamp(timestamp: string | null | undefined): number | null {
	if (!timestamp) return null;
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? null : parsed;
}

export function resolveRunDurationMs(run: RunDurationInput, nowMs: number): number | null {
	const startedAtMs = parseTimestamp(run.startedAt);

	if (run.status === 'running') {
		return startedAtMs === null ? null : Math.max(0, nowMs - startedAtMs);
	}

	if (run.durationMs !== null && run.durationMs !== undefined) {
		return run.durationMs;
	}

	const completedAtMs = parseTimestamp(run.completedAt);
	if (startedAtMs === null || completedAtMs === null) return null;
	return Math.max(0, completedAtMs - startedAtMs);
}

export function useNow(active: boolean, tickMs = LIVE_DURATION_TICK_MS): number {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!active) return;

		setNow(Date.now());
		const intervalId = window.setInterval(() => setNow(Date.now()), tickMs);
		return () => window.clearInterval(intervalId);
	}, [active, tickMs]);

	return now;
}
