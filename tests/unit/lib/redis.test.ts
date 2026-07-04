import { describe, expect, it } from 'vitest';
import { parseRedisUrl } from '@/lib/redis.js';

describe('parseRedisUrl', () => {
	it('parses host, port, and password', () => {
		expect(parseRedisUrl('redis://:s3cret@redis.internal:6380')).toEqual({
			host: 'redis.internal',
			port: 6380,
			password: 's3cret',
			maxRetriesPerRequest: null,
		});
	});

	it('defaults the port to 6379 when the URL omits it', () => {
		expect(parseRedisUrl('redis://localhost')).toMatchObject({
			host: 'localhost',
			port: 6379,
		});
	});

	it('omits the password when the URL has none', () => {
		expect(parseRedisUrl('redis://localhost:6379').password).toBeUndefined();
	});
});
