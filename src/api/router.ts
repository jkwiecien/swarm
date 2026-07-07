import { pingRouter } from './routers/ping.js';
import { projectsRouter } from './routers/projects.js';
import { router } from './trpc.js';

export const appRouter = router({
	ping: pingRouter,
	projects: projectsRouter,
});

export type AppRouter = typeof appRouter;
