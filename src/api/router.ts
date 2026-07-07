import { pingRouter } from './routers/ping.js';
import { router } from './trpc.js';

export const appRouter = router({
	ping: pingRouter,
});

export type AppRouter = typeof appRouter;
