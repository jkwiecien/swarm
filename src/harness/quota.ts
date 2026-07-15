import { z } from 'zod';
import { AgentCliSchema } from './agent-cli.js';

export const QuotaWindowSchema = z.object({
	name: z.string(),
	durationMins: z.number().optional(),
	usedPercent: z.number().optional(),
	resetsAt: z.string().optional(), // ISO timestamp
});

export const CliQuotaSnapshotSchema = z.object({
	cli: AgentCliSchema,
	status: z.enum(['available', 'unavailable', 'error']),
	remainingPercentage: z.number().min(0).max(100).optional(),
	resetTime: z.string().optional(), // ISO timestamp or descriptive string
	plan: z.string().optional(), // e.g. "plus", "free", "pro"
	credits: z.string().optional(), // e.g. "available: 1", "balance: 0"
	source: z.enum(['live', 'fallback']),
	error: z.string().optional(),
	lastUpdated: z.string(), // ISO timestamp
	windows: z.array(QuotaWindowSchema).optional(),
});

export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;
export type CliQuotaSnapshot = z.infer<typeof CliQuotaSnapshotSchema>;
