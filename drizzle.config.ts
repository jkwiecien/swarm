import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: [
		'./src/db/schema/projects.ts',
		'./src/db/schema/projectCredentials.ts',
		'./src/db/schema/runs.ts',
		'./src/db/schema/appSettings.ts',
		'./src/db/schema/cliQuotas.ts',
	],
	out: './src/db/migrations',
	dialect: 'postgresql',
	dbCredentials: {
		url: process.env.DATABASE_URL ?? '',
	},
});
