import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

describe('Security headers (helmet)', () => {
  it('sets X-Content-Type-Options header', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['x-content-type-options']).toBe('nosniff');

    await app.close();
  });

  it('sets X-Frame-Options header', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');

    await app.close();
  });

  it('sets X-XSS-Protection header', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['x-xss-protection']).toBeDefined();

    await app.close();
  });

  it('sets Strict-Transport-Security header', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    // Helmet sets HSTS by default
    expect(response.headers['strict-transport-security']).toBeDefined();

    await app.close();
  });

  it('sets X-DNS-Prefetch-Control header', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['x-dns-prefetch-control']).toBe('off');

    await app.close();
  });
});
