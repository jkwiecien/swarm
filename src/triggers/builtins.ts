/**
 * Built-in trigger registration — the worker's one call site for wiring
 * handlers into a fresh registry, mirroring Cascade's `registerBuiltInTriggers`.
 *
 * Empty on purpose: the four pipeline-phase handlers register here as they land
 * — Planning (SWARM-18), Implementation (SWARM-19), Review (SWARM-20),
 * Respond-to-review (SWARM-21). Until then every dequeued job resolves to "no
 * trigger matched" and completes as a logged no-op.
 */

import type { TriggerRegistry } from './registry.js';

export function registerBuiltInTriggers(_registry: TriggerRegistry): void {
	// Intentionally empty — see the module doc comment.
}
