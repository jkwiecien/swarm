/**
 * Responsive width contract shared by the persisted (`RunsTable`) and queued
 * (`QueuedRunsSection`) run tables. The eight fixed-percentage columns crush
 * below legibility on mobile widths (~375–430px), so the table keeps an
 * intrinsic minimum width and lets its bordered `overflow-x-auto` wrapper
 * scroll horizontally; at the dashboard's `md` breakpoint `md:min-w-full`
 * restores the current full-width desktop layout so column proportions are
 * unchanged. Kept here so both tables share one contract and their aligned
 * layouts cannot drift (issue #371).
 */
export const runTableResponsiveWidth = 'min-w-[48rem] md:min-w-full';

/** Shared widths for the queued and persisted run tables. */
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
