import type React from 'react';
import type { BoardMappingForm } from '@/lib/board-mapping.js';
import { STATUS_KEY_LABELS, STATUS_KEYS } from '@/lib/board-mapping.js';
import type { PmStatusKey } from '../../../../src/pm/pipeline.js';

/**
 * The GitHub Projects board-mapping form. This is provider-specific by design
 * (issue #84): GitHub Projects is the only PM provider today, and the fields
 * below — a Projects v2 project node ID, its Status field node ID, and the
 * per-status single-select option IDs — are GitHub Projects concepts. A future
 * PM provider supplies its own mapping component beside this one rather than
 * generalizing it, keeping provider vocabulary at the seam (ai/RULES.md §2).
 *
 * Purely presentational: the owning route holds the state and the save/reset
 * handlers, mirroring the sibling forms in `routes/projects/$projectId.tsx`.
 */
interface GitHubProjectsMappingFormProps {
	form: BoardMappingForm;
	setProjectId: (value: string) => void;
	setStatusFieldId: (value: string) => void;
	setStatusOption: (key: PmStatusKey, value: string) => void;
	handleSubmit: (e: React.FormEvent) => void;
	handleReset: () => void;
	isDirty: boolean;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
	errorMessage?: string;
}

const INPUT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';

const LABEL_CLASS = 'block text-xs font-medium text-zinc-400 mb-1';

export function GitHubProjectsMappingForm({
	form,
	setProjectId,
	setStatusFieldId,
	setStatusOption,
	handleSubmit,
	handleReset,
	isDirty,
	isPending,
	isSuccess,
	isError,
	errorMessage,
}: GitHubProjectsMappingFormProps) {
	return (
		<div className="border border-zinc-800 rounded-lg bg-[#0F0F11]/40 p-6 shadow-sm">
			<form onSubmit={handleSubmit} className="space-y-6">
				<div>
					<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
						GitHub Projects Board Mapping
					</h2>
					<p className="text-xs text-zinc-400 mb-4">
						The GraphQL node IDs SWARM uses to read and move items on this project's GitHub Projects
						(v2) board. These are opaque IDs, not the human-facing project number — read them from
						the board's GraphQL API. Moving an item through the pipeline writes one of the status
						option IDs below to the Status field.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<div>
							<label htmlFor="projectId" className={LABEL_CLASS}>
								Project ID <span className="text-red-500">*</span>
							</label>
							<input
								type="text"
								id="projectId"
								value={form.projectId}
								onChange={(e) => setProjectId(e.target.value)}
								disabled={isPending}
								required
								placeholder="PVT_kwDO…"
								className={INPUT_CLASS}
							/>
							<p className="text-xs text-zinc-500 mt-1">
								The Projects v2 project node ID (the board).
							</p>
						</div>

						<div>
							<label htmlFor="statusFieldId" className={LABEL_CLASS}>
								Status Field ID <span className="text-red-500">*</span>
							</label>
							<input
								type="text"
								id="statusFieldId"
								value={form.statusFieldId}
								onChange={(e) => setStatusFieldId(e.target.value)}
								disabled={isPending}
								required
								placeholder="PVTSSF_lADO…"
								className={INPUT_CLASS}
							/>
							<p className="text-xs text-zinc-500 mt-1">
								The single-select "Status" field's node ID.
							</p>
						</div>
					</div>
				</div>

				<div>
					<h3 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-1">
						Status Options
					</h3>
					<p className="text-xs text-zinc-400 mb-4">
						The single-select option ID for each SWARM pipeline status. Option IDs are stable across
						renames, so map the ID rather than the display name. Leave a status blank if the board
						has no matching option.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
						{STATUS_KEYS.map((key) => (
							<div key={key}>
								<label htmlFor={`statusOption-${key}`} className={LABEL_CLASS}>
									{STATUS_KEY_LABELS[key]} <span className="text-zinc-600 font-mono">({key})</span>
								</label>
								<input
									type="text"
									id={`statusOption-${key}`}
									value={form.statusOptions[key]}
									onChange={(e) => setStatusOption(key, e.target.value)}
									disabled={isPending}
									placeholder="option id"
									className={INPUT_CLASS}
								/>
							</div>
						))}
					</div>
				</div>

				{isSuccess && (
					<div className="p-3 bg-emerald-950/20 border border-emerald-900/30 text-sm text-emerald-400 rounded">
						Board mapping saved successfully.
					</div>
				)}

				{isError && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						Failed to save board mapping: {errorMessage}
					</div>
				)}

				<div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
					<button
						type="submit"
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed"
					>
						{isPending ? 'Saving…' : 'Save Changes'}
					</button>
					<button
						type="button"
						onClick={handleReset}
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
					>
						Reset
					</button>
				</div>
			</form>
		</div>
	);
}
