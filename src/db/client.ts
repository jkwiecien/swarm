import fs, { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

/**
 * Postgres connection + Drizzle instance — mirrors Cascade's `src/db/client.ts`,
 * trimmed to SWARM's single-user scope. `DATABASE_URL` is the primary config
 * (that's what docker-compose.yml sets); the `SWARM_POSTGRES_*` parts are a
 * fallback for running against a manually-configured instance.
 */

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

interface DatabaseConfig {
	connectionString: string;
	max?: number;
	ssl: false | { rejectUnauthorized: boolean; ca?: string };
}

/**
 * Encapsulates a Drizzle database instance and its underlying connection pool.
 * Use `createDatabaseContext()` to create instances.
 */
export class DatabaseContext {
	private db: DrizzleDb;
	private pool: pg.Pool;

	constructor(config: DatabaseConfig) {
		this.pool = new pg.Pool({
			connectionString: config.connectionString,
			max: config.max ?? 5,
			ssl: config.ssl,
		});
		this.db = drizzle(this.pool, { schema });
	}

	getDb(): DrizzleDb {
		return this.db;
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}

/** Create a DatabaseContext from environment variables. */
export function createDatabaseContext(): DatabaseContext {
	return new DatabaseContext({
		connectionString: getDatabaseUrl(),
		ssl: getSslConfig(),
	});
}

let _defaultContext: DatabaseContext | null = null;

/**
 * Set the default DatabaseContext used by `getDb()`. Pass a mock context in
 * tests to inject a fake database; pass `null` to reset.
 */
export function setDefaultDatabaseContext(context: DatabaseContext | null): void {
	_defaultContext = context;
}

/**
 * Returns the default database instance, lazily initializing a global
 * DatabaseContext on first call.
 */
export function getDb(): DrizzleDb {
	if (!_defaultContext) {
		_defaultContext = createDatabaseContext();
	}
	return _defaultContext.getDb();
}

/**
 * Closes the default database connection pool and resets the context.
 * Safe to call even if the db has never been initialized.
 */
export async function closeDb(): Promise<void> {
	if (_defaultContext) {
		await _defaultContext.close();
		_defaultContext = null;
	}
}

function getDatabaseUrl(): string {
	if (process.env.DATABASE_URL) {
		return process.env.DATABASE_URL;
	}

	const host = process.env.SWARM_POSTGRES_HOST;
	if (host) {
		const port = process.env.SWARM_POSTGRES_PORT || '5432';
		const user = process.env.SWARM_POSTGRES_USER || 'swarm';
		const password = process.env.SWARM_POSTGRES_PASSWORD || '';
		const database = process.env.SWARM_POSTGRES_DB || 'swarm';
		return `postgresql://${user}:${password}@${host}:${port}/${database}`;
	}

	throw new Error('DATABASE_URL or SWARM_POSTGRES_HOST must be set');
}

function getSslConfig(): false | { rejectUnauthorized: boolean; ca?: string } {
	if (process.env.DATABASE_SSL === 'false') {
		return false;
	}
	const sslConfig: { rejectUnauthorized: boolean; ca?: string } = { rejectUnauthorized: true };
	if (process.env.DATABASE_CA_CERT) {
		const certPath = process.env.DATABASE_CA_CERT;
		if (!existsSync(certPath)) {
			throw new Error(`DATABASE_CA_CERT file not found: ${certPath}`);
		}
		sslConfig.ca = fs.readFileSync(certPath, 'utf8');
	}
	return sslConfig;
}
