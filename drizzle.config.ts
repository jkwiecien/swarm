import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: [
		'./src/db/schema/projects.ts',
		'./src/db/schema/projectCredentials.ts',
		'./src/db/schema/runs.ts',
	],
	out: './src/db/migrations',
	dialect: 'postgresql',
	dbCredentials: {
		url: process.env.DATABASE_URL ?? '',
	},
});
