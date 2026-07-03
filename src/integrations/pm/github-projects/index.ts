/**
 * GitHub Projects PM provider — registration entry.
 *
 * Side-effect module: importing it builds the provider's `PMProviderManifest`
 * and registers it into `pmProviderRegistry` at module load. It's pulled in by
 * the single canonical entrypoint (`src/integrations/entrypoint.ts`), so no
 * runtime surface imports this file directly — that's the "one import line in
 * the barrel" half of the registration pattern (ai/CODING_STANDARDS.md "Module
 * shape for a provider").
 *
 * The manifest is also exported for tests and for callers that want the
 * provider's pieces without going through the registry.
 */

import { GitHubProjectsRouterAdapter } from '../../../router/adapters/github-projects.js';
import type { PMProviderManifest } from '../manifest.js';
import { registerPMProvider } from '../registry.js';
import { githubProjectsConfigSchema } from './config-schema.js';

export const githubProjectsManifest: PMProviderManifest = {
	id: 'github-projects',
	label: 'GitHub Projects',
	category: 'pm',
	configSchema: githubProjectsConfigSchema,
	routerAdapter: new GitHubProjectsRouterAdapter(),
};

registerPMProvider(githubProjectsManifest);
