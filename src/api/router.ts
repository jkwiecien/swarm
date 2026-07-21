import '../integrations/entrypoint.js';
import { authRouter } from './routers/auth.js';
import { pingRouter } from './routers/ping.js';
import { projectsRouter } from './routers/projects.js';
import { quotaRouter } from './routers/quota.js';
import { runsRouter } from './routers/runs.js';
import { scmRouter } from './routers/scm.js';
import { settingsRouter } from './routers/settings.js';
import { workersRouter } from './routers/workers.js';
import { router } from './trpc.js';

export const appRouter = router({
	auth: authRouter,
	ping: pingRouter,
	projects: projectsRouter,
	runs: runsRouter,
	scm: scmRouter,
	settings: settingsRouter,
	quota: quotaRouter,
	workers: workersRouter,
});

export type AppRouter = typeof appRouter;
