import { z } from 'zod';

import { getGitHubUserForToken } from '../../integrations/scm/github/client.js';
import { publicProcedure, router } from '../trpc.js';

/**
 * SCM verification API — lets the dashboard confirm a pasted credential resolves
 * to a real identity before it is persisted via `credentials.set` (#79); this
 * procedure stores nothing itself. Mirrors Cascade's
 * `integrationsDiscovery.verifyGithubToken`, but returns a `{ valid }` result
 * instead of throwing on a bad token: it delegates to the existing
 * `getGitHubUserForToken` (`src/integrations/scm/github/client.ts`), which
 * already swallows a failed lookup to `null`, so there is no new GitHub-API code
 * here. `publicProcedure` because the whole `/trpc` surface is `DASHBOARD_TOKEN`
 * bearer-guarded (see `credentials.ts`).
 *
 * GitHub is SWARM's only SCM provider today; a second provider (Bitbucket,
 * GitLab) would add its own `verify…` procedure beside this one rather than
 * generalising it (ai/RULES.md §2).
 */
export const scmRouter = router({
	verifyGithubToken: publicProcedure
		.input(z.object({ token: z.string().min(1) }))
		.mutation(async ({ input }) => {
			const login = await getGitHubUserForToken(input.token);
			return login ? { valid: true as const, login } : { valid: false as const };
		}),
});
