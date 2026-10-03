import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { sendPublicCacheable } from '../src/routes/cacheable.js';

describe('public conditional responses', () => {
  it('returns an ETag and answers a matching If-None-Match with 304', async () => {
    const app = Fastify();
    app.get('/public', async (request, reply) =>
      sendPublicCacheable(request, reply, { value: 'current' }),
    );

    const firstResponse = await app.inject({ method: 'GET', url: '/public' });
    const etag = firstResponse.headers.etag;
    expect(etag).toBeDefined();
    expect(firstResponse.headers['cache-control']).toContain('public');

    const cachedResponse = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { 'if-none-match': `W/${etag}` },
    });

    expect(cachedResponse.statusCode).toBe(304);
    expect(cachedResponse.body).toBe('');
    expect(cachedResponse.headers.etag).toBe(etag);

    await app.close();
  });
});
