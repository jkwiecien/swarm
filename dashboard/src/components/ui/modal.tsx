import { X } from 'lucide-react';
import type React from 'react';
import { useEffect } from 'react';

interface ModalProps {
	open: boolean;
	onClose: () => void;
	title: string;
	children: React.ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			}
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => {
			window.removeEventListener('keydown', handleKeyDown);
		};
	}, [open, onClose]);

	if (!open) return null;

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click doesn't need keyboard equivalent as Escape key handler exists
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click doesn't need keyboard equivalent as Escape key handler exists
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
			onClick={onClose}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation doesn't need keyboard equivalent */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation doesn't need keyboard equivalent */}
			<div
				className="w-full max-w-lg rounded-lg border border-zinc-800 bg-panel p-6 shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between border-b border-zinc-850 pb-4 mb-4">
					<h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
					<button
						type="button"
						onClick={onClose}
						className="text-zinc-500 hover:text-zinc-200 p-1 rounded hover:bg-zinc-800/60 transition-colors"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}

interface ModalFooterProps {
	primary: React.ReactNode;
	secondary: React.ReactNode;
}

export function ModalFooter({ primary, secondary }: ModalFooterProps) {
	return (
		<div className="flex flex-row-reverse gap-2 mt-6">
			{primary}
			{secondary}
		</div>
	);
}
