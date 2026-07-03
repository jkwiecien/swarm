/**
 * PMProviderManifest — the single declarative contract describing a PM provider
 * end-to-end, so a provider registers itself in one place and shared code looks
 * it up by `id` instead of branching on a concrete provider
 * (ai/CODING_STANDARDS.md "Module shape for a provider").
 *
 * Mirrors Cascade's `src/integrations/pm/manifest.ts`, but **scoped down to
 * SWARM's MVP** — the same trimming `src/pm/types.ts` did to Cascade's
 * `PMProvider`. Cascade's manifest carries ~15 fields because it ships three
 * providers plus a wizard/discovery/tRPC layer; SWARM has exactly one provider
 * (GitHub Projects) and only the pieces below exist today. The rest are left out
 * until the phase that needs them, so the manifest doesn't advertise a contract
 * nothing implements:
 *
 * - `credentialRoles` / `webhookRoute` / `verifyWebhookSignature` — SWARM's
 *   GitHub Projects and SCM subscriptions share one `/github/webhook` route and
 *   one HMAC secret (`src/router/webhook-receiver.ts`,
 *   docs/github-projects-v2-api.md §5), so there's no per-provider route or
 *   signature scheme to declare, and credentials are a fixed
 *   implementer/reviewer/webhookSecret triple (`src/config/schema.ts`), not a
 *   provider-specific role list.
 * - `pmIntegration` (the agent-facing `PMProvider` GraphQL adapter),
 *   `triggerHandlers`, `platformClientFactory`, `extractProjectIdFromJob` — the
 *   adapter, trigger registry, and worker job dispatch are separate Phase-2/
 *   later issues; they get manifest fields when they exist, not before.
 * - wizard / discovery / lifecycle-conformance fields — SWARM has no setup
 *   wizard, and the conformance harness is explicitly deferred until there's a
 *   second provider (ai/TESTING.md "Provider conformance").
 *
 * `routerAdapter` is typed to the concrete `GitHubProjectsRouterAdapter` because
 * there's one provider: a shared `PMRouterAdapter` interface would be
 * speculative today (ai/TESTING.md "don't build it speculatively"). It gets
 * extracted the moment a second PM provider lands — the same point a `pm/index.ts`
 * barrel and the conformance harness arrive.
 */

import type { z } from 'zod';
import type { PMType } from '../../pm/types.js';
import type { GitHubProjectsRouterAdapter } from '../../router/adapters/github-projects.js';

export interface PMProviderManifest {
	/** Stable registry key / provider discriminator, e.g. `github-projects`. */
	readonly id: PMType;
	/** Human-readable provider name (for logs and any future provider-select UI). */
	readonly label: string;
	readonly category: 'pm';

	/**
	 * The provider's own persisted-config Zod schema — the single source of truth
	 * for its board mapping (ai/CODING_STANDARDS.md "Zod is the source of truth").
	 * Declaring it here lets registry consumers find a provider's config contract
	 * without importing the provider folder directly. The central
	 * `src/config/schema.ts` still composes it by import today; routing that
	 * through the registry is a later cleanup, not part of this contract.
	 */
	readonly configSchema: z.ZodTypeAny;

	/**
	 * The provider's router-side webhook adapter (parse → resolve project → filter
	 * → loop-prevention). Held as a shared instance because the adapter is
	 * stateless (see `GitHubProjectsRouterAdapter`), so the receiver reuses one
	 * rather than constructing it per request.
	 */
	readonly routerAdapter: GitHubProjectsRouterAdapter;
}
