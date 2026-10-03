import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server.js';

const ALLOWED_ORIGIN = 'https://app.streamgive.example';
const OTHER_ORIGIN = 'https://evil.example';

function preflight(app: ReturnType<typeof buildServer>, origin: string) {
  return app.inject({
    method: 'OPTIONS',
    url: '/v1/ngo-applications',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'x-admin-address,x-admin-signature,x-admin-timestamp',
    },
  });
}

describe('CORS origin allowlist', () => {
  let originalOrigins: string | undefined;

  beforeEach(() => {
    // buildServer() reads CORS_ORIGINS on every call, so setting it here
    // (rather than relying on the default) pins the allowlist under test.
    originalOrigins = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = ALLOWED_ORIGIN;
  });

  afterEach(() => {
    if (originalOrigins === undefined) {
      delete process.env.CORS_ORIGINS;
    } else {
      process.env.CORS_ORIGINS = originalOrigins;
    }
  });

  it('echoes an allowed origin on a preflight request', async () => {
    const app = buildServer();

    const response = await preflight(app, ALLOWED_ORIGIN);

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);

    await app.close();
  });

  it('omits access-control-allow-origin for an origin outside the list', async () => {
    const app = buildServer();

    const response = await preflight(app, OTHER_ORIGIN);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();

    await app.close();
  });

  it('allows the x-admin-* headers on a preflight request', async () => {
    const app = buildServer();

    const response = await preflight(app, ALLOWED_ORIGIN);

    const allowed = String(response.headers['access-control-allow-headers'])
      .split(',')
      .map((header) => header.trim().toLowerCase());
    expect(allowed).toEqual(
      expect.arrayContaining(['x-admin-address', 'x-admin-signature', 'x-admin-timestamp']),
    );

    await app.close();
  });
});
