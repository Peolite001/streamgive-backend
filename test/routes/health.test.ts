import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';

describe('GET /health', () => {
  beforeEach(() => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{}]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 200 and status ok when database is reachable', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });

  it('serves Swagger UI and an OpenAPI document in development', async () => {
    const app = buildServer();

    const ui = await app.inject({ method: 'GET', url: '/docs/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');

    const spec = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().openapi).toMatch(/^3\./);
    expect(spec.json().paths['/streams']).toBeDefined();
    expect(spec.json().paths['/ngos']).toBeDefined();

    await app.close();
  });

  it('responds with a structured 503 error when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Database connection failed'));

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', database: 'unreachable' });

    await app.close();
  });
  it('does not rate limit repeated health checks', async () => {
    const previousMax = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_MAX = '1';
    const app = buildServer();

    const responses = await Promise.all(
      Array.from({ length: 3 }, () => app.inject({ method: 'GET', url: '/health' })),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);

    await app.close();
    if (previousMax === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = previousMax;
  });
});
