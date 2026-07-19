import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	decryptCredential,
	encryptCredential,
	isEncryptedValue,
	isEncryptionEnabled,
	validateCredentialMasterKey,
} from '@/db/crypto.js';

// A valid 32-byte (64-char hex) master key for tests.
const TEST_KEY = randomBytes(32).toString('hex');

describe('crypto', () => {
	beforeEach(() => {
		vi.stubEnv('CREDENTIAL_MASTER_KEY', TEST_KEY);
	});

	describe('isEncryptionEnabled', () => {
		it('is true when CREDENTIAL_MASTER_KEY is set', () => {
			expect(isEncryptionEnabled()).toBe(true);
		});

		it('is false when CREDENTIAL_MASTER_KEY is unset', () => {
			vi.stubEnv('CREDENTIAL_MASTER_KEY', '');
			expect(isEncryptionEnabled()).toBe(false);
		});
	});

	describe('isEncryptedValue', () => {
		it('recognizes the enc:v1: prefix', () => {
			expect(isEncryptedValue('enc:v1:aa:bb:cc')).toBe(true);
		});

		it('treats plaintext as unencrypted', () => {
			expect(isEncryptedValue('test-credential-abc123')).toBe(false);
			expect(isEncryptedValue('')).toBe(false);
		});
	});

	describe('round-trip encrypt/decrypt', () => {
		it('encrypts then decrypts back to the original', () => {
			const plaintext = 'test-credential-abc123def456';
			const encrypted = encryptCredential(plaintext, 'swarm');
			expect(encrypted).toMatch(/^enc:v1:/);
			expect(encrypted).not.toContain(plaintext);
			expect(decryptCredential(encrypted, 'swarm')).toBe(plaintext);
		});

		it('handles empty, unicode, and long values', () => {
			for (const plaintext of ['', '🔑 tøken 日本語', 'x'.repeat(10000)]) {
				const encrypted = encryptCredential(plaintext, 'swarm');
				expect(decryptCredential(encrypted, 'swarm')).toBe(plaintext);
			}
		});

		it('produces a different ciphertext each time (random IV)', () => {
			const a = encryptCredential('same', 'swarm');
			const b = encryptCredential('same', 'swarm');
			expect(a).not.toBe(b);
			expect(decryptCredential(a, 'swarm')).toBe('same');
			expect(decryptCredential(b, 'swarm')).toBe('same');
		});
	});

	describe('AAD binding (projectId)', () => {
		it('fails to decrypt under a different projectId', () => {
			const encrypted = encryptCredential('secret', 'project-a');
			expect(() => decryptCredential(encrypted, 'project-b')).toThrow();
		});

		it('detects a tampered ciphertext', () => {
			const encrypted = encryptCredential('secret', 'swarm');
			const parts = encrypted.split(':');
			// Flip the last hex char of the ciphertext segment.
			const data = parts[4];
			const flipped = data.slice(0, -1) + (data.at(-1) === '0' ? '1' : '0');
			const tampered = [parts[0], parts[1], parts[2], parts[3], flipped].join(':');
			expect(() => decryptCredential(tampered, 'swarm')).toThrow();
		});
	});

	describe('plaintext pass-through when encryption is disabled', () => {
		beforeEach(() => {
			vi.stubEnv('CREDENTIAL_MASTER_KEY', '');
		});

		it('encryptCredential returns the plaintext unchanged', () => {
			expect(encryptCredential('test-credential-abc', 'swarm')).toBe('test-credential-abc');
		});

		it('decryptCredential returns plaintext values as-is', () => {
			expect(decryptCredential('test-credential-abc', 'swarm')).toBe('test-credential-abc');
		});

		it('throws when asked to decrypt an encrypted value with no key', () => {
			vi.stubEnv('CREDENTIAL_MASTER_KEY', TEST_KEY);
			const encrypted = encryptCredential('secret', 'swarm');
			vi.stubEnv('CREDENTIAL_MASTER_KEY', '');
			expect(() => decryptCredential(encrypted, 'swarm')).toThrow(/not set/);
		});
	});

	describe('malformed values', () => {
		it('throws on a structurally invalid encrypted value', () => {
			expect(() => decryptCredential('enc:v1:onlyonepart', 'swarm')).toThrow(/Malformed/);
		});
	});

	describe('validateCredentialMasterKey', () => {
		it('accepts an unset key (encryption is opt-in)', () => {
			vi.stubEnv('CREDENTIAL_MASTER_KEY', '');
			expect(validateCredentialMasterKey()).toEqual({ valid: true });
		});

		it('accepts a well-formed 64-char hex key', () => {
			expect(validateCredentialMasterKey()).toEqual({ valid: true });
		});

		it('rejects a wrong-length key', () => {
			vi.stubEnv('CREDENTIAL_MASTER_KEY', 'abcd');
			const result = validateCredentialMasterKey();
			expect(result.valid).toBe(false);
		});

		it('rejects a non-hex key of the right length', () => {
			vi.stubEnv('CREDENTIAL_MASTER_KEY', 'z'.repeat(64));
			const result = validateCredentialMasterKey();
			expect(result.valid).toBe(false);
		});
	});
});
