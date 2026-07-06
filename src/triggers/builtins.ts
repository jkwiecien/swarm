/**
 * Built-in trigger registration — the worker's one call site for wiring the
 * pipeline-phase handlers into a fresh registry, mirroring Cascade's
 * `registerBuiltInTriggers`.
 *
 * The three handlers map inbound events onto the pipeline phases
 * (ai/ARCHITECTURE.md "Pipeline phases"): a board card entering Planning / In
 * progress starts Planning / Implementation (`pm-status-changed` — one handler
 * covers both, since which phase to start comes from an authoritative board
 * re-read); a PR opening or its checks passing starts Review, while a check
 * suite that *failed* starts Respond-to-CI (`pr-review` — one handler covers
 * both, since the review-vs-fix split comes from one aggregate-CI query); the
 * reviewer persona requesting changes starts Respond-to-review
 * (`pr-review-submitted`). Each handler resolves the phase's inputs and the
 * worker's `processJob` runs the matching orchestrator (`src/pipeline/*`).
 *
 * Registration order matters — the registry dispatches first-match-wins
 * (`registry.ts`) — but these handlers key off disjoint event types
 * (`projects_v2_item` vs `pull_request` vs `check_suite` vs
 * `pull_request_review`), so no two ever both match the same event. The order
 * below follows Cascade's (review-lifecycle handlers ahead of the PM one) for
 * familiarity, not correctness.
 */

import { createPmStatusTrigger } from './handlers/pm-status.js';
import { createRespondToReviewTrigger } from './handlers/respond-to-review.js';
import { createReviewTrigger } from './handlers/review.js';
import type { TriggerRegistry } from './registry.js';

export function registerBuiltInTriggers(registry: TriggerRegistry): void {
	registry.register(createReviewTrigger());
	registry.register(createRespondToReviewTrigger());
	registry.register(createPmStatusTrigger());
}
