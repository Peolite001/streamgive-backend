import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer, parseTrustProxy, type TrustProxySetting } from '../src/server.js';

describe('parseTrustProxy helper', () => {
  it('defaults to true when undefined or empty', () => {
    expect(parseTrustProxy(undefined)).toBe(true);
    expect(parseTrustProxy('')).toBe(true);
    expect(parseTrustProxy('   ')).toBe(true);
  });

  it('parses boolean strings', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('TRUE')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('FALSE')).toBe(false);
  });

  it('parses numeric hop count strings into a bounded hop function', () => {
    const hop1 = parseTrustProxy('1');
    expect(typeof hop1).toBe('function');
    if (typeof hop1 === 'function') {
      expect(hop1('127.0.0.1', 0)).toBe(true);
      expect(hop1('127.0.0.1', 1)).toBe(false);
      expect(hop1('127.0.0.1', 2)).toBe(false);
    }

    const hop2 = parseTrustProxy('2');
    expect(typeof hop2).toBe('function');
    if (typeof hop2 === 'function') {
      expect(hop2('127.0.0.1', 0)).toBe(true);
      expect(hop2('127.0.0.1', 1)).toBe(true);
      expect(hop2('127.0.0.1', 2)).toBe(false);
    }

    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('-1')).toBe(false);
  });

  it('parses single IP or CIDR strings', () => {
    expect(parseTrustProxy('127.0.0.1')).toBe('127.0.0.1');
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });

  it('parses comma-separated lists of IPs/CIDRs', () => {
    expect(parseTrustProxy('127.0.0.1, 10.0.0.0/8, 192.168.1.1')).toEqual([
      '127.0.0.1',
      '10.0.0.0/8',
      '192.168.1.1',
    ]);
  });
});

describe('trustProxy and rate limiter keying behind proxy', () => {
  const originalRateLimitMax = process.env.RATE_LIMIT_MAX;
  const originalRateLimitWindow = process.env.RATE_LIMIT_WINDOW;
  const originalRateLimitAppMax = process.env.RATE_LIMIT_APPLICATION_MAX;
  const originalRateLimitAppWindow = process.env.RATE_LIMIT_APPLICATION_WINDOW;
  const originalTrustProxy = process.env.TRUST_PROXY;

  beforeEach(() => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_WINDOW = '1 minute';
  });

  afterEach(() => {
    if (originalRateLimitMax === undefined) {
      delete process.env.RATE_LIMIT_MAX;
    } else {
      process.env.RATE_LIMIT_MAX = originalRateLimitMax;
    }

    if (originalRateLimitWindow === undefined) {
      delete process.env.RATE_LIMIT_WINDOW;
    } else {
      process.env.RATE_LIMIT_WINDOW = originalRateLimitWindow;
    }

    if (originalRateLimitAppMax === undefined) {
      delete process.env.RATE_LIMIT_APPLICATION_MAX;
    } else {
      process.env.RATE_LIMIT_APPLICATION_MAX = originalRateLimitAppMax;
    }

    if (originalRateLimitAppWindow === undefined) {
      delete process.env.RATE_LIMIT_APPLICATION_WINDOW;
    } else {
      process.env.RATE_LIMIT_APPLICATION_WINDOW = originalRateLimitAppWindow;
    }

    if (originalTrustProxy === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = originalTrustProxy;
    }
  });

  it('keys rate limiting by real client IP from X-Forwarded-For when trustProxy is enabled (default)', async () => {
    delete process.env.TRUST_PROXY;
    const app = buildServer();

    // Client A (203.0.113.1) sends 2 allowed requests
    const resA1 = await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    expect(resA1.statusCode).toBe(200);

    const resA2 = await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    expect(resA2.statusCode).toBe(200);

    // Client A sends a 3rd request -> throttled with 429
    const resA3 = await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    expect(resA3.statusCode).toBe(429);

    // Client B (198.51.100.2) makes a request behind the same proxy
    // Because trustProxy keys by real client IP, Client B is NOT throttled
    const resB1 = await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': '198.51.100.2' },
    });
    expect(resB1.statusCode).toBe(200);

    await app.close();
  });

  it('keys rate limiting by real client IP when TRUST_PROXY is configured via environment variable', async () => {
    process.env.TRUST_PROXY = 'true';
    const app = buildServer();

    const clientA = '192.0.2.10';
    const clientB = '192.0.2.20';

    // Exhaust client A's limit
    await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': clientA },
    });
    await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': clientA },
    });

    const throttledA = await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': clientA },
    });
    expect(throttledA.statusCode).toBe(429);

    // Client B should still succeed
    const okB = await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': clientB },
    });
    expect(okB.statusCode).toBe(200);

    await app.close();
  });

  it('keys rate limiting by real client IP when bounded hop count is configured', async () => {
    // 1 hop: trusts 1 proxy hop (the immediate connection), reading the client IP right before it
    process.env.TRUST_PROXY = '1';
    const app = buildServer();

    const clientA = '192.0.2.100';
    const clientB = '192.0.2.200';

    // Even if client attempts to spoof an upstream header: 'spoofed_ip, real_client'
    // A hop count of 1 trusts the proxy and reads clientA as the real client IP.
    await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': `203.0.113.99, ${clientA}` },
    });
    await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': `203.0.113.99, ${clientA}` },
    });

    const throttledA = await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': `203.0.113.99, ${clientA}` },
    });
    expect(throttledA.statusCode).toBe(429);

    // Different client through the same proxy hop is not throttled
    const okB = await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': `203.0.113.99, ${clientB}` },
    });
    expect(okB.statusCode).toBe(200);

    await app.close();
  });

  it('demonstrates the failure mode when trustProxy is disabled: all clients share the proxy IP', async () => {
    process.env.TRUST_PROXY = 'false';
    const app = buildServer();

    // Client A sends 2 requests
    await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });

    // Client B sends request with different X-Forwarded-For
    // Without trustProxy, Fastify keys to the underlying socket IP (127.0.0.1)
    // so Client B gets unfairly throttled by Client A's requests!
    const sharedThrottled = await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': '198.51.100.2' },
    });
    expect(sharedThrottled.statusCode).toBe(429);

    await app.close();
  });

  it('allows programmatic override via buildServer({ trustProxy })', async () => {
    process.env.TRUST_PROXY = 'false'; // env says false
    const app = buildServer({ trustProxy: true as TrustProxySetting }); // option overrides to true

    await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': '203.0.113.50' },
    });
    await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': '203.0.113.50' },
    });

    const throttledA = await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': '203.0.113.50' },
    });
    expect(throttledA.statusCode).toBe(429);

    const okB = await app.inject({
      method: 'GET',
      url: '/indexer/status',
      headers: { 'x-forwarded-for': '203.0.113.51' },
    });
    expect(okB.statusCode).toBe(200);

    await app.close();
  });

  it('keys route-specific rate limiting for /ngo-applications by real client IP', async () => {
    process.env.RATE_LIMIT_APPLICATION_MAX = '2';
    process.env.RATE_LIMIT_APPLICATION_WINDOW = '1 minute';
    process.env.TRUST_PROXY = 'true';
    const app = buildServer();

    const clientA = '198.51.100.10';
    const clientB = '198.51.100.20';

    // Client A sends 2 requests to /ngo-applications
    const resA1 = await app.inject({
      method: 'POST',
      url: '/ngo-applications',
      headers: { 'x-forwarded-for': clientA },
      payload: {},
    });
    // Request fails validation with 400, but is counted by the route rate limiter
    expect(resA1.statusCode).toBe(400);

    const resA2 = await app.inject({
      method: 'POST',
      url: '/ngo-applications',
      headers: { 'x-forwarded-for': clientA },
      payload: {},
    });
    expect(resA2.statusCode).toBe(400);

    // Client A sends a 3rd request -> throttled by the /ngo-applications rate limiter (429)
    const resA3 = await app.inject({
      method: 'POST',
      url: '/ngo-applications',
      headers: { 'x-forwarded-for': clientA },
      payload: {},
    });
    expect(resA3.statusCode).toBe(429);

    // Client B sends request behind the same proxy -> gets 400 (not throttled by Client A!)
    const resB1 = await app.inject({
      method: 'POST',
      url: '/ngo-applications',
      headers: { 'x-forwarded-for': clientB },
      payload: {},
    });
    expect(resB1.statusCode).toBe(400);

    await app.close();
  });
});
