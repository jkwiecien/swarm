import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef } from 'react';

export interface LiveOutputEvent {
	id: number;
	stream: 'stdout' | 'stderr';
	content: string;
	emittedAt: string | Date;
}

interface LiveOutputViewerProps {
	events: LiveOutputEvent[];
	isRunning: boolean;
	isLoading: boolean;
	retentionBytes: number;
	serverTruncated: boolean;
	uiTruncated: boolean;
}

export function LiveOutputViewer({
	events,
	isRunning,
	isLoading,
	retentionBytes,
	serverTruncated,
	uiTruncated,
}: LiveOutputViewerProps) {
	const endRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// Effects may only return a cleanup function. Some browser implementations
		// return a value from scrollIntoView(), so do not return that expression.
		endRef.current?.scrollIntoView({ block: 'nearest' });
	});

	return (
		<div className="border border-zinc-800 rounded-lg bg-zinc-950 overflow-hidden shadow-sm">
			<div className="flex items-center justify-between border-b border-zinc-850 bg-zinc-900/40 px-4 py-3 text-xs">
				<span className="text-zinc-400">
					Raw CLI stdout and stderr · retained up to {(retentionBytes / 1_000_000).toFixed(0)} MB
				</span>
				<span className={isRunning ? 'text-emerald-400' : 'text-zinc-500'}>
					{isRunning ? '● Live' : 'Run ended'}
				</span>
			</div>
			{(serverTruncated || uiTruncated) && (
				<div className="flex items-center gap-2 border-b border-amber-900/30 bg-amber-950/20 px-4 py-2 text-xs text-amber-200/80">
					<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
					{serverTruncated
						? 'Output retention limit reached; later CLI output was not stored.'
						: 'Older entries are hidden in this browser to keep rendering responsive. Reload to inspect from the beginning.'}
				</div>
			)}
			<div className="max-h-[600px] min-h-[300px] overflow-auto p-4 font-mono text-xs leading-relaxed">
				{events.length === 0 ? (
					<div className="flex min-h-[250px] items-center justify-center italic text-zinc-500">
						{isLoading ? 'Loading live output…' : 'No CLI output captured yet.'}
					</div>
				) : (
					events.map((event) => (
						<div
							key={event.id}
							className="grid grid-cols-[7.5rem_3.5rem_1fr] gap-2 whitespace-pre-wrap"
						>
							<time className="select-none text-zinc-600">
								{new Date(event.emittedAt).toLocaleTimeString()}
							</time>
							<span className={event.stream === 'stderr' ? 'text-red-400' : 'text-sky-400'}>
								{event.stream}
							</span>
							<span className={event.stream === 'stderr' ? 'text-red-300' : 'text-zinc-300'}>
								{event.content}
							</span>
						</div>
					))
				)}
				<div ref={endRef} />
			</div>
		</div>
	);
}
