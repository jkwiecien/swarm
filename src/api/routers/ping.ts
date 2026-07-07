import { publicProcedure, router } from '../trpc.js';

/**
 * Trivial health/liveness procedure that proves the tRPC wire-up end to end.
 * Replaced/joined by real routers (projects, credentials) in later issues.
 */
export const pingRouter = router({
	ping: publicProcedure.query(() => ({
		message: 'pong',
		timestamp: new Date().toISOString(),
	})),
});
