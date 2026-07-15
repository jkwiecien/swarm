import { eq } from 'drizzle-orm';
import type { AgentCli } from '../../harness/agent-cli.js';
import type { CliQuotaSnapshot } from '../../harness/quota.js';
import { getDb } from '../client.js';
import { cliQuotas } from '../schema/cliQuotas.js';

/**
 * Get all CLI quota snapshots currently persisted in the database.
 */
export async function getAllCliQuotas(): Promise<CliQuotaSnapshot[]> {
	const rows = await getDb().select().from(cliQuotas).orderBy(cliQuotas.cli);
	return rows.map((r) => r.snapshot);
}

/**
 * Get a specific CLI's quota snapshot.
 */
export async function getCliQuota(cli: AgentCli): Promise<CliQuotaSnapshot | null> {
	const rows = await getDb().select().from(cliQuotas).where(eq(cliQuotas.cli, cli)).limit(1);
	return rows[0]?.snapshot ?? null;
}

/**
 * Upsert a CLI's quota snapshot.
 */
export async function upsertCliQuota(
	cli: AgentCli,
	status: 'available' | 'unavailable' | 'error',
	snapshot: CliQuotaSnapshot,
): Promise<void> {
	await getDb()
		.insert(cliQuotas)
		.values({
			cli,
			status,
			snapshot,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: cliQuotas.cli,
			set: {
				status,
				snapshot,
				updatedAt: new Date(),
			},
		});
}
