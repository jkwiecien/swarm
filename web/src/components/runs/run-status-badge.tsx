import type { ComponentProps } from 'react';

type RunStatus = 'running' | 'completed' | 'failed' | 'deferred';

interface RunStatusBadgeProps extends ComponentProps<'span'> {
	status: RunStatus;
	/**
	 * When the run failed specifically because it hit its wall-clock timeout,
	 * render an unambiguous "Timed out" badge instead of a generic "Failed" — so
	 * a run the worker killed for running too long reads distinctly from one that
	 * exited with an error (issue #165).
	 */
	timedOut?: boolean;
	/**
	 * The run's pipeline phase. A completed `review` run with a {@link reviewVerdict}
	 * shows that verdict instead of the generic "Completed" badge (issue #218);
	 * any other phase, or a non-completed status, falls through to the lifecycle
	 * badge so failed/running/deferred/cancelled runs never show a stale verdict.
	 */
	phase?: string;
	/**
	 * The verdict a completed Review run submitted (`approve` / `request-changes`
	 * / `comment`). Null/absent for non-review phases and pre-existing rows, which
	 * keep the lifecycle badge (issue #218).
	 */
	reviewVerdict?: string | null;
}

interface BadgeConfig {
	text: string;
	classes: string;
	dotClass: string;
	pulse?: boolean;
}

const STATUS_CONFIGS: Record<RunStatus, BadgeConfig> = {
	running: {
		text: 'Running',
		classes: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
		dotClass: 'bg-blue-400',
		pulse: true,
	},
	completed: {
		text: 'Completed',
		classes: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
		dotClass: 'bg-emerald-400',
	},
	failed: {
		text: 'Failed',
		classes: 'bg-red-500/10 text-red-400 border-red-500/20',
		dotClass: 'bg-red-400',
	},
	deferred: {
		text: 'Deferred',
		classes: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
		dotClass: 'bg-amber-400',
	},
};

const TIMED_OUT_CONFIG: BadgeConfig = {
	text: 'Timed out',
	classes: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
	dotClass: 'bg-orange-400',
};

/**
 * Human-readable, semantically-coloured labels for a completed Review run's
 * submitted verdict (issue #218): approval reuses the green "Completed" hue,
 * changes-requested the amber "Deferred" hue, and any other verdict (today just
 * `comment`) a distinct violet so it reads as neither a pass nor a rejection.
 * The label text — not colour alone — carries the meaning, so the badges stay
 * legible to colour-blind users and screen readers.
 */
const REVIEW_VERDICT_CONFIGS: Record<string, BadgeConfig> = {
	approve: {
		text: 'Approved',
		classes: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
		dotClass: 'bg-emerald-400',
	},
	'request-changes': {
		text: 'Changes requested',
		classes: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
		dotClass: 'bg-amber-400',
	},
	comment: {
		text: 'Commented',
		classes: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
		dotClass: 'bg-violet-400',
	},
};

/** Title-case a hyphenated verdict key for a label ('some-verdict' → 'Some verdict'). */
function humanizeVerdict(verdict: string): string {
	const spaced = verdict.replace(/-/g, ' ');
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Fallback violet badge for any verdict not in {@link REVIEW_VERDICT_CONFIGS}. */
function verdictFallbackConfig(verdict: string): BadgeConfig {
	return {
		text: humanizeVerdict(verdict),
		classes: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
		dotClass: 'bg-violet-400',
	};
}

function resolveBadgeConfig(
	status: RunStatus,
	timedOut: boolean,
	phase: string | undefined,
	reviewVerdict: string | null | undefined,
): BadgeConfig {
	if (status === 'failed' && timedOut) return TIMED_OUT_CONFIG;
	// A completed Review run shows its verdict rather than "Completed"; anything
	// non-completed (or a review row missing its verdict) keeps lifecycle status.
	if (status === 'completed' && phase === 'review' && reviewVerdict) {
		return REVIEW_VERDICT_CONFIGS[reviewVerdict] ?? verdictFallbackConfig(reviewVerdict);
	}
	return (
		STATUS_CONFIGS[status] ?? {
			text: status,
			classes: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
			dotClass: 'bg-zinc-400',
		}
	);
}

export function RunStatusBadge({
	status,
	timedOut = false,
	phase,
	reviewVerdict,
	className = '',
	...props
}: RunStatusBadgeProps) {
	const config = resolveBadgeConfig(status, timedOut, phase, reviewVerdict);

	return (
		<span
			className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold border ${config.classes} ${className}`}
			{...props}
		>
			<span
				className={`h-1.5 w-1.5 rounded-full ${config.dotClass} ${config.pulse ? 'animate-pulse' : ''}`}
			/>
			{config.text}
		</span>
	);
}
