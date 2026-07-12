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
}

export function RunStatusBadge({
	status,
	timedOut = false,
	className = '',
	...props
}: RunStatusBadgeProps) {
	if (status === 'failed' && timedOut) {
		return (
			<span
				className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold border bg-orange-500/10 text-orange-400 border-orange-500/20 ${className}`}
				{...props}
			>
				<span className="h-1.5 w-1.5 rounded-full bg-orange-400" />
				Timed out
			</span>
		);
	}

	const configs: Record<
		RunStatus,
		{ text: string; classes: string; dotClass: string; pulse?: boolean }
	> = {
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

	const config = configs[status] || {
		text: status,
		classes: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
		dotClass: 'bg-zinc-400',
	};

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
