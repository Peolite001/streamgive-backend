import { describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server.js';

describe('Global Error Handler', () => {
  it('normalizes unhandled exceptions into { error: "..." } shape without leaking internal details', async () => {
    const app = buildServer();

    app.get('/test-error', async () => {
      throw new Error('Database connection secret details');
    });

    const response = await app.inject({
      method: 'GET',
      url: '/test-error',
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body).toEqual({ error: 'internal_server_error' });
    expect(JSON.stringify(body)).not.toContain('Database connection secret details');

    await app.close();
  });
});
