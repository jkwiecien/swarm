import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

interface LogViewerProps {
	stdout: string | null;
	stderr: string | null;
}

export function LogViewer({ stdout, stderr }: LogViewerProps) {
	const [activeTab, setActiveTab] = useState<'stdout' | 'stderr'>('stdout');
	const [copied, setCopied] = useState(false);

	const activeContent = activeTab === 'stdout' ? stdout : stderr;
	const isContentEmpty = !activeContent || activeContent.trim() === '';

	const handleCopy = async () => {
		if (!activeContent) return;
		try {
			await navigator.clipboard.writeText(activeContent);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			console.error('Failed to copy text: ', err);
		}
	};

	return (
		<div className="border border-zinc-800 rounded-lg bg-zinc-950 overflow-hidden flex flex-col shadow-sm">
			{/* Log Viewer Header */}
			<div className="flex items-center justify-between border-b border-zinc-850 bg-zinc-900/40 px-4 py-2 text-xs">
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => setActiveTab('stdout')}
						className={`px-3 py-1.5 font-semibold rounded transition-colors cursor-pointer ${
							activeTab === 'stdout'
								? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
								: 'text-zinc-400 hover:text-zinc-200 border border-transparent'
						}`}
					>
						Stdout
					</button>
					<button
						type="button"
						onClick={() => setActiveTab('stderr')}
						className={`px-3 py-1.5 font-semibold rounded transition-colors cursor-pointer ${
							activeTab === 'stderr'
								? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
								: 'text-zinc-400 hover:text-zinc-200 border border-transparent'
						}`}
					>
						Stderr
					</button>
				</div>

				{!isContentEmpty && (
					<button
						type="button"
						onClick={handleCopy}
						className="inline-flex items-center gap-1 px-2.5 py-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors cursor-pointer"
					>
						{copied ? (
							<>
								<Check className="h-3.5 w-3.5 text-emerald-400" />
								<span className="text-emerald-400 font-medium">Copied!</span>
							</>
						) : (
							<>
								<Copy className="h-3.5 w-3.5" />
								<span>Copy</span>
							</>
						)}
					</button>
				)}
			</div>

			{/* Log Viewer Body */}
			<div className="p-4 overflow-auto max-h-[600px] min-h-[250px] font-mono text-xs leading-relaxed text-zinc-300 whitespace-pre-wrap">
				{isContentEmpty ? (
					<div className="flex h-full items-center justify-center text-zinc-500 py-12 italic">
						No {activeTab === 'stdout' ? 'stdout' : 'stderr'} logs captured for this run.
					</div>
				) : (
					activeContent
				)}
			</div>
		</div>
	);
}
