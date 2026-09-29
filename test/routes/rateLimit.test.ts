import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server.js';

describe('rate limit 429 responses', () => {
  const originalMax = process.env.RATE_LIMIT_MAX;
  const originalWindow = process.env.RATE_LIMIT_WINDOW;

  afterEach(() => {
    if (originalMax === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = originalMax;
    if (originalWindow === undefined) delete process.env.RATE_LIMIT_WINDOW;
    else process.env.RATE_LIMIT_WINDOW = originalWindow;
  });

  it('includes a Retry-After header when the limit is exceeded', async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_WINDOW = '1 minute';

    const app = buildServer();

    const first = await app.inject({ method: 'GET', url: '/health' });
    const second = await app.inject({ method: 'GET', url: '/health' });
    const third = await app.inject({ method: 'GET', url: '/health' });

    expect(first.statusCode).not.toBe(429);
    expect(second.statusCode).not.toBe(429);
    expect(third.statusCode).toBe(429);

    // A client can only back off intelligently if the value is a positive,
    // machine-readable number of seconds.
    const retryAfter = third.headers['retry-after'];
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number.isInteger(Number(retryAfter))).toBe(true);

    await app.close();
  });

  it('applies the global limit to /health, which is not declared with a custom config', async () => {
    process.env.RATE_LIMIT_MAX = '1';
    process.env.RATE_LIMIT_WINDOW = '1 minute';

    const app = buildServer();

    const first = await app.inject({ method: 'GET', url: '/health' });
    const second = await app.inject({ method: 'GET', url: '/health' });

    // The limiter runs in an onRequest hook, before the handler, so the
    // second request is rejected whatever the database does.
    expect(first.statusCode).not.toBe(429);
    expect(first.headers['x-ratelimit-limit']).toBe('1');
    expect(second.statusCode).toBe(429);

    await app.close();
  });
});
