/**
 * Read a required environment variable, throwing if it is unset or empty.
 *
 * Missing required config is a programmer/deployment error, not a "not found"
 * lookup — so this throws rather than returning null (see ai/CODING_STANDARDS.md
 * "Error handling").
 */
export function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

/**
 * Read an optional environment variable, falling back to `fallback` when unset
 * or empty.
 */
export function optionalEnv(name: string, fallback: string): string {
	const value = process.env[name];
	return value === undefined || value === '' ? fallback : value;
}
