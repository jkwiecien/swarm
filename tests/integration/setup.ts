import { afterAll, beforeAll } from 'vitest';
import { closeTestDb, resolveTestDbUrl, resolveTestRedisUrl, runMigrations } from './helpers/db.js';

/**
 * Integration-project setup (vitest.config.ts wires this in for the
 * `integration` project only) — trimmed from Cascade's `tests/integration/setup.ts`.
 *
 * Points the app's own `getDb()` at the ephemeral test database by setting
 * `DATABASE_URL`, runs migrations once, and closes the pool afterwards. When no
 * test database is reachable the suites skip themselves (via the
 * `SWARM_TEST_DB_AVAILABLE` flag each file gates on with `describe.skipIf`)
 * rather than fail — a machine without Docker still gets a green run
 * (ai/TESTING.md).
 */

// A malformed CREDENTIAL_MASTER_KEY inherited from the shell would make
// encryptCredential throw in tests that don't stub it. Drop it so the suite is
// deterministic regardless of ambient env — tests that need a key stub one via
// `vi.stubEnv`.
delete process.env.CREDENTIAL_MASTER_KEY;

const resolvedUrl = await resolveTestDbUrl();

if (!resolvedUrl) {
	console.warn(
		'[integration] No reachable test database found — skipping all integration tests.\n' +
			'  Run `npm run test:db:up` to start the Docker Compose test database.',
	);
	// A DATABASE_URL inherited from the shell would point getDb() at a *real*
	// database — and these suites TRUNCATE. Drop it so any test that forgets its
	// skipIf gate fails loudly in getDb() instead of touching live data.
	delete process.env.DATABASE_URL;
	delete process.env.SWARM_POSTGRES_HOST;
	process.env.SWARM_TEST_DB_AVAILABLE = '';
} else {
	process.env.DATABASE_URL = resolvedUrl;
	process.env.DATABASE_SSL = 'false';
	process.env.SWARM_TEST_DB_AVAILABLE = '1';

	// Redis is optional on top of Postgres: BullMQ-dependent suites gate on
	// SWARM_TEST_REDIS_AVAILABLE the same way DB suites gate on the flag above.
	const resolvedRedisUrl = await resolveTestRedisUrl();
	if (resolvedRedisUrl) {
		process.env.REDIS_URL = resolvedRedisUrl;
		process.env.SWARM_TEST_REDIS_AVAILABLE = '1';
	} else {
		console.warn(
			'[integration] No reachable test Redis found — skipping Redis/BullMQ integration tests.\n' +
				'  Run `npm run test:db:up` to start the Docker Compose test services.',
		);
		delete process.env.REDIS_URL;
		process.env.SWARM_TEST_REDIS_AVAILABLE = '';
	}

	beforeAll(async () => {
		await runMigrations();
	});

	afterAll(async () => {
		await closeTestDb();
	});
}
