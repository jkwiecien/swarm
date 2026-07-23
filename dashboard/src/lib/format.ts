import type { AgentUsage } from '@/types/runs.js';

export function formatDuration(ms: number | null): string {
	if (ms === null || ms === undefined) return '—';
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remainingSec = sec % 60;
	return `${min}m ${remainingSec}s`;
}

export function formatRelativeTime(dateString: string): string {
	const date = new Date(dateString);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffSec = Math.floor(diffMs / 1000);
	if (diffSec < 60) return 'Just now';
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	return (
		date.toLocaleDateString() +
		' ' +
		date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	);
}

export function formatTimeUntil(dateString: string): string {
	const diffMs = new Date(dateString).getTime() - Date.now();
	if (diffMs <= 60_000) return 'shortly';
	const diffMin = Math.ceil(diffMs / 60_000);
	if (diffMin < 60) return `in ${diffMin} min`;
	return `in ~${Math.round(diffMin / 60)} h`;
}

export function formatPhase(phase: string): string {
	return phase.replace(/-/g, ' ');
}

/** Strip trailing zeros left by `toFixed`, e.g. "1.0" → "1", "1.20" → "1.2". */
function trimTrailingZero(s: string): string {
	if (!s.includes('.')) return s;
	return s.replace(/0+$/, '').replace(/\.$/, '');
}

/** Compact token count for a dense table cell: `1234` → `1.2k`, `1050000` → `1.05M`. */
export function formatTokenCount(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${trimTrailingZero((n / 1000).toFixed(1))}k`;
	return `${trimTrailingZero((n / 1_000_000).toFixed(2))}M`;
}

/** `"12.3k / 4.1k"` (input / output tokens), or `'—'` when usage wasn't reported. */
export function formatTokensCompact(usage: AgentUsage | null): string {
	if (!usage) return '—';
	return `${formatTokenCount(usage.inputTokens)} / ${formatTokenCount(usage.outputTokens)}`;
}
