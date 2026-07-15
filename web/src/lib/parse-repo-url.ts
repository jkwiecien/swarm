export interface ParsedRepoUrl {
	owner: string;
	repo: string;
	id: string; // slugified repo name
	name: string; // repo name as-is
}

/**
 * Parses a repository URL generically to extract owner, repo name, slugified ID, and name.
 * Accepts formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - github.com/owner/repo
 */
export function parseRepoUrl(url: string): ParsedRepoUrl | null {
	if (!url) return null;

	// 1. Clean query parameters and hash fragments
	let str = url.trim().split(/[?#]/)[0];

	// 2. Strip protocol (e.g. https://, git+ssh://, etc.)
	str = str.replace(/^[a-zA-Z+-]+:\/\//, '');

	// 3. Strip username prefix if present (e.g. git@)
	str = str.replace(/^[^@]+@/, '');

	// 4. Replace the host-owner separator ":" with "/" if it's SCP-like syntax (not followed by a port number)
	str = str.replace(/^([^/:]+):(?!\d+\/)/, '$1/');

	// 5. Split into segments and filter empty ones
	const segments = str.split('/').filter(Boolean);

	// We expect at least a host, an owner, and a repo name (at least 3 segments)
	if (segments.length < 3) {
		return null;
	}

	// The last segment is the repo name, the second-to-last is the owner
	let repoSegment = segments[segments.length - 1];
	const owner = segments[segments.length - 2];

	// Tolerating a trailing .git
	if (repoSegment.endsWith('.git')) {
		repoSegment = repoSegment.slice(0, -4);
	}

	if (!repoSegment || !owner) {
		return null;
	}

	// ID: slugified repo name (lowercase, non-[a-z0-9-] runs collapsed to -, trimmed)
	const id = repoSegment
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');

	if (!id) {
		return null;
	}

	return {
		owner,
		repo: `${owner}/${repoSegment}`,
		id,
		name: repoSegment,
	};
}
