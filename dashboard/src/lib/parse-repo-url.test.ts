import { describe, expect, it } from 'vitest';
import { parseRepoUrl } from './parse-repo-url.js';

describe('parseRepoUrl', () => {
	it('parses HTTPS URLs', () => {
		const result = parseRepoUrl('https://github.com/owner/repo');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('parses HTTPS URLs with trailing .git', () => {
		const result = parseRepoUrl('https://github.com/owner/repo.git');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('parses git@ SSH URLs', () => {
		const result = parseRepoUrl('git@github.com:owner/repo.git');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('parses plain domain URLs', () => {
		const result = parseRepoUrl('github.com/owner/repo');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('handles trailing slash', () => {
		const result = parseRepoUrl('https://github.com/owner/repo/');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('handles query parameters and hash fragments', () => {
		const result = parseRepoUrl('https://github.com/owner/repo.git?foo=bar#L12');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('slugifies name for ID properly', () => {
		const result = parseRepoUrl('https://github.com/Some-Org/My_Awesome.Repo.123');
		expect(result).toEqual({
			owner: 'Some-Org',
			repo: 'Some-Org/My_Awesome.Repo.123',
			id: 'my-awesome-repo-123',
			name: 'My_Awesome.Repo.123',
		});
	});

	it('handles generic hosts and host port', () => {
		const result = parseRepoUrl('https://gitlab.custom-domain.org:8080/some-group/project.git');
		expect(result).toEqual({
			owner: 'some-group',
			repo: 'some-group/project',
			id: 'project',
			name: 'project',
		});
	});

	it('handles SSH with ssh:// protocol and custom port', () => {
		const result = parseRepoUrl('ssh://git@altssh.gitlab.com:443/owner/repo-name.git');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo-name',
			id: 'repo-name',
			name: 'repo-name',
		});
	});

	it('handles org starting with digits', () => {
		const result = parseRepoUrl('git@github.com:123org/repo-name.git');
		expect(result).toEqual({
			owner: '123org',
			repo: '123org/repo-name',
			id: 'repo-name',
			name: 'repo-name',
		});
	});

	it('returns null for invalid inputs', () => {
		expect(parseRepoUrl('')).toBeNull();
		expect(parseRepoUrl('not-a-url')).toBeNull();
		expect(parseRepoUrl('github.com/owner')).toBeNull(); // missing repo name
		expect(parseRepoUrl('https://github.com/')).toBeNull();
	});
});
