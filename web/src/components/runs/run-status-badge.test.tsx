// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunStatusBadge } from './run-status-badge.js';

describe('RunStatusBadge', () => {
	describe('completed Review runs show the submitted verdict (issue #218)', () => {
		it('renders an approval as a green "Approved" badge', () => {
			render(<RunStatusBadge status="completed" phase="review" reviewVerdict="approve" />);
			const badge = screen.getByText('Approved');
			expect(badge.className).toContain('text-emerald-400');
			expect(screen.queryByText('Completed')).toBeNull();
		});

		it('renders a changes-requested verdict as an amber "Changes requested" badge', () => {
			render(<RunStatusBadge status="completed" phase="review" reviewVerdict="request-changes" />);
			const badge = screen.getByText('Changes requested');
			expect(badge.className).toContain('text-amber-400');
		});

		it('renders a comment verdict as a distinct violet "Commented" badge', () => {
			render(<RunStatusBadge status="completed" phase="review" reviewVerdict="comment" />);
			const badge = screen.getByText('Commented');
			expect(badge.className).toContain('text-violet-400');
		});

		it('falls back to a violet, humanized label for an unknown verdict', () => {
			render(<RunStatusBadge status="completed" phase="review" reviewVerdict="needs-info" />);
			const badge = screen.getByText('Needs info');
			expect(badge.className).toContain('text-violet-400');
		});
	});

	describe('lifecycle status is kept where a verdict must not show', () => {
		it('shows "Completed" for a completed non-Review run even if a verdict slipped through', () => {
			render(<RunStatusBadge status="completed" phase="implementation" reviewVerdict="approve" />);
			expect(screen.getByText('Completed')).not.toBeNull();
			expect(screen.queryByText('Approved')).toBeNull();
		});

		it('shows "Completed" for a completed Review run that has no verdict (older rows)', () => {
			render(<RunStatusBadge status="completed" phase="review" reviewVerdict={null} />);
			expect(screen.getByText('Completed')).not.toBeNull();
		});

		it('shows lifecycle "Failed", not a stale verdict, for a failed Review run', () => {
			render(<RunStatusBadge status="failed" phase="review" reviewVerdict="approve" />);
			expect(screen.getByText('Failed')).not.toBeNull();
			expect(screen.queryByText('Approved')).toBeNull();
		});

		it('shows lifecycle status for running and deferred Review runs', () => {
			const { rerender } = render(<RunStatusBadge status="running" phase="review" />);
			expect(screen.getByText('Running')).not.toBeNull();
			rerender(<RunStatusBadge status="deferred" phase="review" />);
			expect(screen.getByText('Deferred')).not.toBeNull();
		});

		it('still renders "Timed out" for a timed-out failure regardless of phase (issue #165)', () => {
			render(<RunStatusBadge status="failed" phase="review" timedOut reviewVerdict="approve" />);
			expect(screen.getByText('Timed out')).not.toBeNull();
		});
	});
});
