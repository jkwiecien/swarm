import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Most dashboard tests exercise pure helpers, so a node environment is the
// default; component tests opt into jsdom + @testing-library per-file with a
// `// @vitest-environment jsdom` pragma. Mirror the `@` → dashboard/src alias so
// imports resolve the same way tsc/vite do.
export default defineConfig({
	test: {
		name: 'dashboard',
		globals: true,
		environment: 'node',
		// Match the root unit project's thread pool: the default `forks` pool uses
		// child_process IPC, which collides with the IPC channel of the process
		// that spawns the test run.
		pool: 'threads',
		include: ['src/**/*.test.{ts,tsx}'],
	},
	resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
