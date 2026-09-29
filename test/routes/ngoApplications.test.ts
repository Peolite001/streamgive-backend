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

describe('POST /ngo-applications', () => {
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
      url: '/ngo-applications',
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
      url: '/ngo-applications',
      payload: validApplicationPayload({ contactEmail: 'not-an-email' }),
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('rejects a second pending application from the same address with 409', async () => {
    const app = buildServer();
    const payload = validApplicationPayload();

    const first = await app.inject({ method: 'POST', url: '/ngo-applications', payload });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: 'POST', url: '/ngo-applications', payload });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it('rejects a new application from an already-approved NGO with 409 already_approved', async () => {
    const app = buildServer();
    const payload = validApplicationPayload();

    await prisma.ngoApplication.create({
      data: { ...payload, status: 'APPROVED' },
    });

    const response = await app.inject({ method: 'POST', url: '/ngo-applications', payload });
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

    const response = await app.inject({ method: 'POST', url: '/ngo-applications', payload });
    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe('PENDING');

    await app.close();
  });
});

describe('GET /ngo-applications/status', () => {
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
      url: `/ngo-applications/status?ownerAddress=${ownerAddress}`,
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
      url: `/ngo-applications/status?ownerAddress=${fakeAddress('N')}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('not_found');

    await app.close();
  });

  it('rejects a malformed address with 400', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/ngo-applications/status?ownerAddress=not-an-address',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');

    await app.close();
  });

  it('rejects a missing address with 400', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/ngo-applications/status' });

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

    const response = await app.inject({ method: 'GET', url: '/ngo-applications' });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('allows a correctly signed admin request', async () => {
    const app = buildServer();
    const headers = signAdminRequest(adminKeypair, 'GET', '/ngo-applications');

    const response = await app.inject({ method: 'GET', url: '/ngo-applications', headers });
    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it('approves a pending application', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const url = `/ngo-applications/${application.id}/approve`;
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({ method: 'POST', url, headers, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('APPROVED');

    const stored = await prisma.ngoApplication.findUnique({ where: { id: application.id } });
    expect(stored?.status).toBe('APPROVED');

    await app.close();
  });

  it('rejects a signature for a different URL than the one requested', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const realUrl = `/ngo-applications/${application.id}/approve`;
    // Signed for a *different* application's approve endpoint.
    const headers = signAdminRequest(adminKeypair, 'POST', '/ngo-applications/other-id/approve');

    const response = await app.inject({ method: 'POST', url: realUrl, headers, payload: {} });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('rejects approving an already rejected application with 409 already_reviewed', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({
      data: validApplicationPayload({ status: 'REJECTED' }),
    });
    const url = `/ngo-applications/${application.id}/approve`;
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({ method: 'POST', url, headers, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('already_reviewed');

    await app.close();
  });

  it('rejects rejecting an already approved application with 409 already_reviewed', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({
      data: validApplicationPayload({ status: 'APPROVED' }),
    });
    const url = `/ngo-applications/${application.id}/reject`;
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({ method: 'POST', url, headers, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('already_reviewed');

    await app.close();
  });

  it('returns 400 invalid_request when approving with a malformed id', async () => {
    const app = buildServer();
    const url = '/ngo-applications/not-a-uuid/approve';
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({ method: 'POST', url, headers, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');

    await app.close();
  });

  it('returns 400 invalid_request when rejecting with a malformed id', async () => {
    const app = buildServer();
    const url = '/ngo-applications/not-a-uuid/reject';
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({ method: 'POST', url, headers, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');

    await app.close();
  });
});

describe('GET /ngo-applications status filter', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    await resetDb();
  });

  /**
   * Seeds two PENDING rows plus one APPROVED and one REJECTED, and returns the
   * row ids grouped by status.
   *
   * Two rows share the PENDING status deliberately. With exactly one row per
   * status, a `status` filter that was silently ignored would still come back
   * with a single row for every query — the per-status assertions below would
   * pass while testing nothing. Two PENDING rows make the filtered count (2)
   * distinct from both the page size (1) and the unfiltered total (4), so
   * dropping the filter anywhere changes a number we actually assert on.
   */
  async function seedMixedStatuses() {
    const [pendingOne, pendingTwo, approved, rejected] = await Promise.all([
      prisma.ngoApplication.create({
        data: validApplicationPayload({
          ownerAddress: fakeAddress('A'),
          name: 'Pending One',
          status: 'PENDING',
        }),
      }),
      prisma.ngoApplication.create({
        data: validApplicationPayload({
          ownerAddress: fakeAddress('B'),
          name: 'Pending Two',
          status: 'PENDING',
        }),
      }),
      prisma.ngoApplication.create({
        data: validApplicationPayload({
          ownerAddress: fakeAddress('C'),
          name: 'Approved One',
          status: 'APPROVED',
        }),
      }),
      prisma.ngoApplication.create({
        data: validApplicationPayload({
          ownerAddress: fakeAddress('D'),
          name: 'Rejected One',
          status: 'REJECTED',
        }),
      }),
    ]);

    return {
      PENDING: [pendingOne.id, pendingTwo.id].sort(),
      APPROVED: [approved.id],
      REJECTED: [rejected.id],
      all: [pendingOne.id, pendingTwo.id, approved.id, rejected.id].sort(),
    };
  }

  it('returns only the applications matching each status value', async () => {
    const app = buildServer();
    const expected = await seedMixedStatuses();

    for (const status of ['PENDING', 'APPROVED', 'REJECTED'] as const) {
      const url = `/ngo-applications?status=${status}`;
      // The signature covers `${method}:${url}`, query string included, so
      // signing the bare path here would 401 instead of exercising the filter.
      const headers = signAdminRequest(adminKeypair, 'GET', url);

      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Assert the exact expected id set, not merely "no other status leaked
      // in": a filter matching nothing would satisfy the latter, and it is a
      // far easier bug to introduce than an over-broad filter.
      const returnedIds = body.applications
        .map((application: { id: string }) => application.id)
        .sort();
      expect(returnedIds).toEqual(expected[status]);

      // The complement: every returned row actually carries the requested
      // status. This is the acceptance criterion stated directly, so a future
      // refactor to, say, a substring match on `status` fails loudly here.
      for (const application of body.applications as Array<{ status: string }>) {
        expect(application.status).toBe(status);
      }

      // `total` comes from a separate `count` query in the route. It shares
      // the `where` clause with `findMany` today, but nothing enforces that
      // pairing — a filter applied to one and not the other is a classic way
      // for pagination to disagree with itself.
      expect(body.total).toBe(expected[status].length);
    }

    await app.close();
  });

  it('returns every application when no status filter is given', async () => {
    const app = buildServer();
    const expected = await seedMixedStatuses();

    const url = '/ngo-applications';
    const headers = signAdminRequest(adminKeypair, 'GET', url);

    const response = await app.inject({ method: 'GET', url, headers });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // This doubles as a check on the fixture itself. If seeding had quietly
    // produced four rows of one status, the per-status test above could pass
    // without any filtering happening; an unfiltered request that returns all
    // four ids proves the rows really are mixed.
    const returnedIds = body.applications
      .map((application: { id: string }) => application.id)
      .sort();
    expect(returnedIds).toEqual(expected.all);
    expect(body.total).toBe(expected.all.length);

    await app.close();
  });

  it('rejects a status value outside the enum with 400 invalid_request', async () => {
    const app = buildServer();

    // 'pending' is not a typo to tolerate: the column stores uppercase enum
    // values, so accepting it would need a case-insensitive `where`, which is
    // a decision the schema has not made — and silently answering with an
    // empty list would be worse than complaining.
    //
    // The enum is also what keeps an unknown status a clean 400. Passing the
    // raw string through to Prisma instead makes Prisma throw on the invalid
    // enum value, which surfaces to the client as a 500 — so this assertion
    // pins a client-error contract, not just a validation detail.
    for (const status of ['DELETED', 'pending']) {
      const url = `/ngo-applications?status=${status}`;
      const headers = signAdminRequest(adminKeypair, 'GET', url);

      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_request');
    }

    await app.close();
  });

  it('applies limit and offset inside the filtered set while total counts the whole filtered set', async () => {
    const app = buildServer();
    const expected = await seedMixedStatuses();

    const url = '/ngo-applications?status=PENDING&limit=1&offset=1';
    const headers = signAdminRequest(adminKeypair, 'GET', url);

    const response = await app.inject({ method: 'GET', url, headers });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // One row, drawn from the two PENDING rows — not from the four-row table.
    // If `offset` paginated the unfiltered result set, the single row returned
    // here could be a non-PENDING row; the `total` assertion below is what
    // makes that failure deterministic rather than order-dependent.
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].status).toBe('PENDING');
    expect(expected.PENDING).toContain(body.applications[0].id);

    // `total` describes the filtered set, so it stays 2 even though only one
    // row is on this page. A client paging through PENDING applications needs
    // 2 here to know a second page exists.
    expect(body.total).toBe(2);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);

    await app.close();
  });
});
