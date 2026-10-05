import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';

describe('GET /v1/streams', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('filters by donor address', async () => {
    const app = buildServer();

    const donorA = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const donorB = await prisma.donor.create({ data: { address: fakeAddress('B') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('C'), name: 'NGO', verified: true },
    });

    await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donorA.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
      },
    });
    await prisma.stream.create({
      data: {
        onChainId: 2n,
        donorId: donorB.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '200',
        withdrawn: '0',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/streams?donor=${donorA.address}`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0].onChainId).toBe('1');
    // Serialized as a string — the route must never hand back a raw BigInt.
    expect(typeof body.streams[0].onChainId).toBe('string');
    expect(body.hasMore).toBe(false);

    await app.close();
  });

  it('400s on a malformed donor address instead of matching nothing silently', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/streams?donor=not-an-address' });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('400s on a malformed ngo id', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/streams?ngo=not-a-uuid' });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('coerces a string limit and rejects values above the maximum', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('L') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('M'), name: 'Limit NGO', verified: true },
    });
    await prisma.stream.createMany({
      data: Array.from({ length: 3 }, (_, index) => ({
        onChainId: BigInt(50 + index),
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('N'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
      })),
    });

    const coerced = await app.inject({ method: 'GET', url: `/v1/streams?ngo=${ngo.id}&limit=2` });
    expect(coerced.statusCode).toBe(200);
    expect(coerced.json().streams).toHaveLength(2);
    expect(coerced.json().hasMore).toBe(true);

    const tooLarge = await app.inject({ method: 'GET', url: `/v1/streams?ngo=${ngo.id}&limit=101` });
    expect(tooLarge.statusCode).toBe(400);

    await app.close();
  });

  it('pages through results with a filter applied', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const ngo = await prisma.go.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO', verified: true },
    });
    const otherNgo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('C'), name: 'Other NGO', verified: true },
    });

    // Created oldest first so `createdAt desc` returns onChainId 3, 2, 1.
    for (const onChainId of [1n, 2n, 3n]) {
      await prisma.stream.create({
        data: {
          onChainId,
          donorId: donor.id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('D'),
          rate: '1',
          balance: '100',
          withdrawn: '0',
        },
      });
    }
    // Belongs to a different NGO — must never show up in either page below.
    await prisma.stream.create({
      data: {
        onChainId: 4n,
        donorId: donor.id,
        ngoId: otherNgo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
      },
    });

    const firstPage = await app.inject({
      method: 'GET',
      url: `/v1/streams?ngo=${ngo.id}&limit=2`,
    });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json();
    expect(firstBody.streams).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.streams.map((s: { onChainId: string }) => s.onChainId)).toEqual(['3', '2']);
    expect(firstBody.nextCursor).toBe(firstBody.streams[1].id);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/v1/streams?ngo=${ngo.id}&limit=2&cursor=${firstBody.nextCursor}`,
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json();
    expect(secondBody.streams).toHaveLength(1);
    expect(secondBody.streams[0].onChainId).toBe('1');
    expect(secondBody.hasMore).toBe(false);
    expect(secondBody.nextCursor).toBeNull();

    await app.close();
  });
  it('returns hasMore true when more than 100 matching streams exist', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('H') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('I'), name: 'Big NGO', verified: true },
    });

    await prisma.stream.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        onChainId: BigInt(100 + i),
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('T'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
      })),
    });

    const response = await app.inject({ method: 'GET', url: `/v1/streams?ngo=${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.streams).toHaveLength(100);
    expect(body.hasMore).toBe(true);

    await app.close();
  });

  it('filters by ngoAddress and returns only matching streams', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const ngo = await prisma.go.create({
      data: { ownerAddress: fakeAddress('B'), name: 'Target NGO', verified: true },
    });
    const otherNgo = await prisma.go.create({
      data: { ownerAddress: fakeAddress('C'), name: 'Other NGO', verified: true },
    });

    await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
      },
    });
    await prisma.stream.create({
      data: {
        onChainId: 2n,
        donorId: donor.id,
        ngoId: otherNgo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '200',
        withdrawn: '0',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/streams?ngoAddress=${ngo.ownerAddress}`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0].onChainId).toBe('1');

    await app.close();
  });

  it('returns empty list when ngoAddress matches no NGO', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const ngo = await prisma.go.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO', verified: true },
    });

    await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/streams?ngoAddress=${fakeAddress('Z')}`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.streams).toHaveLength(0);

    await app.close();
  });

  it('400s on a malformed ngoAddress', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/streams?ngoAddress=not-an-address',
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('filters by status combined with donor filter', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO', verified: true },
    });

    await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
        status: 'ACTIVE',
      },
    });
    await prisma.stream.create({
      data: {
        onChainId: 2n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '200',
        withdrawn: '0',
        status: 'CANCELLED',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/streams?donor=${donor.address}&status=ACTIVE`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0].onChainId).toBe('1');
    expect(body.streams[0].status).toBe('ACTIVE');

    await app.close();
  });
  it('exposes lastRate for a cancelled stream via GET /v1/streams/:id', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('M') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('N'), name: 'NGO N', verified: true },
    });
    const stream = await prisma.stream.create({
      data: {
        onChainId: 99n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('O'),
        rate: '0',
        lastRate: '42',
        balance: '0',
        withdrawn: '0',
        status: 'CANCELLED',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/streams/${stream.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.rate).toBe('0');
    expect(body.lastRate).toBe('42');
    expect(body.status).toBe('CANCELLED');

    await app.close();
  });

});

describe('GET /v1/streams/:id', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('returns a single stream', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO', verified: true },
    });
    const stream = await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/streams/${stream.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.id).toBe(stream.id);
    expect(body.onChainId).toBe('1');
    expect(typeof body.onChainId).toBe('string');

    await app.close();
  });

  it('includes createdTxHash in single stream response', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO', verified: true },
    });
    const txHash = 'c4515e3bdc0897f21cc5dbec8c82cf0a936d4741cb74a8e158eb51b9fb00411a';
    const stream = await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
        createdTxHash: txHash,
      },
    });

    const response = await app.inject({ method: 'GET', url: `/streams/${stream.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.createdTxHash).toBe(txHash);

    await app.close();
  });

  it('returns null createdTxHash for legacy streams without one', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO', verified: true },
    });
    const stream = await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/streams/${stream.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.createdTxHash).toBeNull();

    await app.close();
  });

  it('404s for an id that does not exist', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/streams/00000000-0000-0000-0000-000000000000',
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('400s for a malformed id instead of leaking a Prisma error', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/streams/not-a-uuid' });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('returns null name and registered false for a stream to an unregistered NGO', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    // Placeholder NGO: name is empty, not yet registered on-chain.
    const ngo = await prisma.go.create({
      data: { ownerAddress: fakeAddress('B'), name: '', verified: false },
    });
    const stream = await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/streams/${stream.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.ngo.name).toBeNull();
    expect(body.ngo.registered).toBe(false);
    // ownerAddress is still present so clients can display the wallet address if they choose.
    expect(body.ngo.ownerAddress).toBe(ngo.ownerAddress);

    await app.close();
  });
});

describe('GET /streams/:id/activity', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('returns a stream\'s events newest first', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const ngo = await prisma.go.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO', verified: true },
    });
    const stream = await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
      },
    });

    // Created oldest first so the response order is CANCELLED -> WITHDRAWAL -> TOP_UP.
    for (const type of ['TOP_UP', 'WITHDRAWAL', 'CANCELLED'] as const) {
      await prisma.streamEvent.create({
        data: { streamId: stream.id, type, amount: '10' },
      });
    }

    const response = await app.inject({
      method: 'GET',
      url: `/streams/${stream.id}/activity`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.events).toHaveLength(3);
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(['CANCELLED', 'WITHDRAWAL', 'TOP_UP']);
    expect(body.hasMore).toBe(false);

    await app.close();
  });

  it('paginates through events with a cursor', async () => {
    const app = buildServer();

    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO', verified: true },
    });
    const stream = await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('D'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
      },
    });

    for (const type of ['TOP_UP', 'WITHDRAWAL', 'CANCELLED'] as const) {
      await prisma.streamEvent.create({
        data: { streamId: stream.id, type, amount: '10' },
      });
    }

    const firstPage = await app.inject({
      method: 'GET',
      url: `/streams/${stream.id}/activity?limit=2`,
    });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json();
    expect(firstBody.events).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.events.map((e: { type: string }) => e.type)).toEqual(['CANCELLED', 'WITHDRAWAL']);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/streams/${stream.id}/activity?limit=2&cursor=${firstBody.events[1].id}`,
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json();
    expect(secondBody.events).toHaveLength(1);
    expect(secondBody.events[0].type).toBe('TOP_UP');
    expect(secondBody.hasMore).toBe(false);

    await app.close();
  });

  it('404s for an unknown stream', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/streams/00000000-0000-0000-0000-000000000000/activity',
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('400s on a malformed stream id', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/streams/not-a-uuid/activity',
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});
