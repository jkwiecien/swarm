/**
 * Shared desktop column widths for the persisted (`RunsTable`) and queued
 * (`QueuedRunsSection`) run tables. The eight fixed-percentage columns only
 * ever render at the dashboard's `md` breakpoint and up — below `md` both
 * tables are replaced by purpose-built stacked cards, so there is no
 * horizontal-scroll workaround here anymore (issue #381, superseding the
 * `min-w-[48rem]` crutch from issue #371). Kept here so both tables share one
 * contract and their aligned column proportions cannot drift.
 */
export function runTableColumnWidths(showProject: boolean): {
	phase: string;
	project: string;
	task: string;
	status: string;
	started: string;
	duration: string;
	model: string;
	tokens: string;
} {
	return showProject
		? {
				phase: 'w-[12%]',
				project: 'w-[8%]',
				task: 'w-[32%]',
				status: 'w-[12%]',
				started: 'w-[8%]',
				duration: 'w-[7%]',
				model: 'w-[12%]',
				tokens: 'w-[9%]',
			}
		: {
				phase: 'w-[12%]',
				project: 'w-0',
				task: 'w-[40%]',
				status: 'w-[12%]',
				started: 'w-[8%]',
				duration: 'w-[7%]',
				model: 'w-[12%]',
				tokens: 'w-[9%]',
			};
}
