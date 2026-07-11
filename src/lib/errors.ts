/**
 * Error helpers for logging.
 *
 * The codebase's usual `err instanceof Error ? err.message : String(err)` drops
 * `err.cause` — and that's exactly where the useful part hides for DB failures.
 * Drizzle wraps every failed query in a `DrizzleQueryError` whose own `.message`
 * is an opaque `Failed query: …` string; the real Postgres reason (`column "…"
 * does not exist`, a constraint name, a connection reset) lives in `.cause`.
 * Logging only the message turns a diagnosable incident into a silent one.
 */

/**
 * Render an error for a log line, walking the `cause` chain so the underlying
 * reason is visible (`Failed query: … ← column "usage" does not exist`). Guards
 * against a cyclic chain and non-Error causes.
 */
export function describeError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const parts: string[] = [err.message];
	const seen = new Set<unknown>([err]);
	let cause: unknown = err.cause;
	while (cause instanceof Error && !seen.has(cause)) {
		seen.add(cause);
		parts.push(cause.message);
		cause = cause.cause;
	}
	return parts.join(' ← ');
}
