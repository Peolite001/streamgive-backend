import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import { signAdminRequest } from '../helpers/adminAuth.js';

const adminKeypair = Keypair.random();

function validApplicationPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ownerAddress: fakeAddress('A'),
    name: 'Test NGO',
    description: 'A test NGO description.',
    contactEmail: 'ngo@example.com',
    ...overrides,
  };
}

describe('POST /v1/ngo-applications', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    await resetDb();
  });

  it('creates a pending application', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: validApplicationPayload(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe('PENDING');

    await app.close();
  });

  it('rejects invalid input with 400', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: validApplicationPayload({ contactEmail: 'not-an-email' }),
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('accepts a scheme-less website domain and normalizes it to https://', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: validApplicationPayload({ website: 'example.org' }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().website).toBe('https://example.org');

    await app.close();
  });

  it('accepts an already-schemed https website without double-prepending', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: validApplicationPayload({ website: 'https://example.org' }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().website).toBe('https://example.org');

    await app.close();
  });

  it('rejects a malformed ownerAddress with 400', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: validApplicationPayload({ ownerAddress: 'invalid-stellar-address' }),
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('rejects a second pending application from the same address with 409', async () => {
    const app = buildServer();
    const payload = validApplicationPayload();

    const first = await app.inject({ method: 'POST', url: '/v1/ngo-applications', payload });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: 'POST', url: '/v1/ngo-applications', payload });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it('rejects a new application from an already-approved NGO with 409 already_approved', async () => {
    const app = buildServer();
    const payload = validApplicationPayload();

    await prisma.ngoApplication.create({
      data: { ...payload, status: 'APPROVED' },
    });

    const response = await app.inject({ method: 'POST', url: '/v1/ngo-applications', payload });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('already_approved');

    await app.close();
  });

  it('allows a rejected applicant to submit a new application', async () => {
    const app = buildServer();
    const payload = validApplicationPayload();

    await prisma.ngoApplication.create({
      data: { ...payload, status: 'REJECTED' },
    });

    const response = await app.inject({ method: 'POST', url: '/v1/ngo-applications', payload });
    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe('PENDING');

    await app.close();
  });

  it('lets only one of two concurrent submissions through', async () => {
    const app = buildServer();
    const payload = validApplicationPayload();

    // Fired together rather than awaited in sequence: sequential requests are
    // already covered above, and only a genuine overlap exercises the race
    // where both requests read "nothing blocking" before either inserts.
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/ngo-applications', payload }),
      app.inject({ method: 'POST', url: '/ngo-applications', payload }),
    ]);

    expect([first.statusCode, second.statusCode].sort((a, b) => a - b)).toEqual([201, 409]);

    const loser = first.statusCode === 409 ? first : second;
    expect(loser.json().error).toBe('application_already_pending');

    const stored = await prisma.ngoApplication.findMany({
      where: { ownerAddress: payload.ownerAddress },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('PENDING');

    await app.close();
  });
});

describe('GET /v1/ngo-applications/status', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('returns only status and timestamps for the latest application', async () => {
    const app = buildServer();
    const ownerAddress = fakeAddress('S');

    await prisma.ngoApplication.create({
      data: validApplicationPayload({ ownerAddress, status: 'REJECTED' }),
    });
    const latest = await prisma.ngoApplication.create({
      data: validApplicationPayload({ ownerAddress, status: 'APPROVED' }),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/ngo-applications/status?ownerAddress=${ownerAddress}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('APPROVED');
    expect(body.createdAt).toBe(latest.createdAt.toISOString());
    expect(body.updatedAt).toBe(latest.updatedAt.toISOString());
    // No contact details or other application fields leak out.
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'status', 'updatedAt']);

    await app.close();
  });

  it('returns 404 when the address has no application', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/ngo-applications/status?ownerAddress=${fakeAddress('N')}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('not_found');

    await app.close();
  });

  it('rejects a malformed address with 400', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/ngo-applications/status?ownerAddress=not-an-address',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');

    await app.close();
  });

  it('rejects a missing address with 400', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications/status' });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('admin NGO application review', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    await resetDb();
  });

  it('rejects an unsigned request with 401', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications' });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('returns 503 when admin authentication is not configured', async () => {
    const app = buildServer();
    const configuredAddress = process.env.ADMIN_ADDRESS;
    delete process.env.ADMIN_ADDRESS;

    try {
      const response = await app.inject({ method: 'GET', url: '/ngo-applications' });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe('admin_auth_not_configured');
    } finally {
      if (configuredAddress === undefined) delete process.env.ADMIN_ADDRESS;
      else process.env.ADMIN_ADDRESS = configuredAddress;
      await app.close();
    }
  });

  it('rejects a validly encoded signature with the wrong byte length', async () => {
    const app = buildServer();
    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngo-applications');
    headers['x-admin-signature'] = Buffer.alloc(63).toString('base64');

    const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications', headers });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('unauthorized');

    await app.close();
  });

  it('allows a correctly signed admin request', async () => {
    const app = buildServer();
    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngo-applications');

    const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications', headers });
    expect(response.statusCode).toBe(200);

    await app.close();
  });

it('rejects a seconds-based timestamp with a clear unit error', async () => {
    const app = buildServer();
    const headers = signAdminRequest(adminKeypair, 'GET', '/ngo-applications', {
      timestamp: Math.floor(Date.now() / 1000),
    });

    const response = await app.inject({ method: 'GET', url: '/ngo-applications', headers });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_timestamp_unit');

    await app.close();
  });

  it('rejects replaying the same signed request within the freshness window', async () => {
    const app = buildServer();
    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngo-applications');

    const first = await app.inject({ method: 'GET', url: '/v1/ngo-applications', headers });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({ method: 'GET', url: '/v1/ngo-applications', headers });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('replayed_signature');

    await app.close();
  });

  it('paginates applications while reporting the full total', async () => {
    const app = buildServer();
    await Promise.all(
      ['A', 'B', 'C'].map((suffix) =>
        prisma.ngoApplication.create({
          data: validApplicationPayload({ ownerAddress: fakeAddress(suffix) }),
        }),
      ),
    );

    const url = '/v1/ngo-applications?limit=2&offset=1';
    const headers = signAdminRequest(adminKeypair, 'GET', url);
    const response = await app.inject({ method: 'GET', url, headers });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(3);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.applications).toHaveLength(2);

    await app.close();
  });
  it('approves a pending application', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const url = `/v1/ngo-applications/${application.id}/approve`;
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({ method: 'POST', url, headers, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('APPROVED');

    const stored = await prisma.ngoApplication.findUnique({ where: { id: application.id } });
    expect(stored?.status).toBe('APPROVED');

    await app.close();
  });

  it('rejects a non-object (array) body on approve with 400 invalid_request', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const url = `/v1/ngo-applications/${application.id}/approve`;
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({ method: 'POST', url, headers, payload: [] as never });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');

    // The invalid request must not have touched the application.
    const stored = await prisma.ngoApplication.findUnique({ where: { id: application.id } });
    expect(stored?.status).toBe('PENDING');

    await app.close();
  });

  it('rejects a non-object (array) body on reject with 400 invalid_request', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const url = `/v1/ngo-applications/${application.id}/reject`;
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: ['not', 'an', 'object'] as never,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');

    const stored = await prisma.ngoApplication.findUnique({ where: { id: application.id } });
    expect(stored?.status).toBe('PENDING');

    await app.close();
  });

  it('rejects a signature for a different URL than the one requested', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const realUrl = `/v1/ngo-applications/${application.id}/approve`;
    // Signed for a *different* application's approve endpoint.
    const headers = signAdminRequest(adminKeypair, 'POST', '/v1/ngo-applications/other-id/approve');

    const response = await app.inject({ method: 'POST', url: realUrl, headers, payload: {} });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('returns 404 when approving or rejecting a non-existent application id', async () => {
    const app = buildServer();

    const nonExistentId = '00000000-0000-0000-0000-000000000000';
    const approveUrl = `/v1/ngo-applications/${nonExistentId}/approve`;
    const approveHeaders = signAdminRequest(adminKeypair, 'POST', approveUrl);

    const approveResponse = await app.inject({
      method: 'POST',
      url: approveUrl,
      headers: approveHeaders,
      payload: {},
    });
    expect(approveResponse.statusCode).toBe(404);
    expect(approveResponse.json().error).toBe('not_found');

    const rejectUrl = `/v1/ngo-applications/${nonExistentId}/reject`;
    const rejectHeaders = signAdminRequest(adminKeypair, 'POST', rejectUrl);

    const rejectResponse = await app.inject({
      method: 'POST',
      url: rejectUrl,
      headers: rejectHeaders,
      payload: {},
    });
    expect(rejectResponse.statusCode).toBe(404);
    expect(rejectResponse.json().error).toBe('not_found');

    await app.close();
  });
});

describe('GET /v1/ngo-applications/stats', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    await resetDb();
  });

  it('rejects an unsigned request with 401', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications/stats' });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('returns counts grouped by status for a signed admin', async () => {
    const app = buildServer();

    await prisma.ngoApplication.createMany({
      data: [
        validApplicationPayload({ ownerAddress: fakeAddress('P'), status: 'PENDING' }),
        validApplicationPayload({ ownerAddress: fakeAddress('P'), status: 'PENDING' }),
        validApplicationPayload({ ownerAddress: fakeAddress('A'), status: 'APPROVED' }),
        validApplicationPayload({ ownerAddress: fakeAddress('R'), status: 'REJECTED' }),
      ],
    });

    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngo-applications/stats');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/ngo-applications/stats',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.counts).toEqual({ PENDING: 2, APPROVED: 1, REJECTED: 1 });
    expect(body.total).toBe(4);

    await app.close();
  });

  it('returns zero counts when there are no applications', async () => {
    const app = buildServer();

    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngo-applications/stats');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/ngo-applications/stats',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.counts).toEqual({ PENDING: 0, APPROVED: 0, REJECTED: 0 });
    expect(body.total).toBe(0);

    await app.close();
  });
});
