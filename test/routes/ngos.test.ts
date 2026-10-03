import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';

describe('GET /ngos', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('returns only verified NGOs, newest first', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Unverified NGO', verified: false },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'Verified NGO', verified: true },
    });

    const response = await app.inject({ method: 'GET', url: '/ngos' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.ngos).toHaveLength(1);
    expect(body.ngos[0].name).toBe('Verified NGO');
    expect(body.nextCursor).toBeNull();

    await app.close();
  });

  it('paginates with cursor and returns no overlap between pages', async () => {
    const app = buildServer();

    // Create 3 verified NGOs — oldest first so createdAt desc gives C, B, A.
    for (const char of ['A', 'B', 'C']) {
      await prisma.ngo.create({
        data: { ownerAddress: fakeAddress(char), name: `NGO ${char}`, verified: true },
      });
    }

    const firstPage = await app.inject({ method: 'GET', url: '/ngos?limit=2' });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json();
    expect(firstBody.ngos).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();
    const firstIds = firstBody.ngos.map((n: { id: string }) => n.id);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/ngos?limit=2&cursor=${firstBody.nextCursor}`,
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json();
    expect(secondBody.ngos).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();

    // No overlap between pages.
    const secondIds = secondBody.ngos.map((n: { id: string }) => n.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);

    await app.close();
  });
  it('returns NGOs oldest first when sort=oldest', async () => {
    const app = buildServer();

    for (const char of ['A', 'B', 'C']) {
      await prisma.ngo.create({
        data: { ownerAddress: fakeAddress(char), name: `NGO ${char}`, verified: true },
      });
    }

    const response = await app.inject({ method: 'GET', url: '/ngos?sort=oldest' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    const names = body.ngos.map((n: { name: string }) => n.name);
    expect(names).toEqual(['NGO A', 'NGO B', 'NGO C']);

    await app.close();
  });

  it('returns NGOs alphabetically when sort=name', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('C'), name: 'Zeta NGO', verified: true },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Alpha NGO', verified: true },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'Midway NGO', verified: true },
    });

    const response = await app.inject({ method: 'GET', url: '/ngos?sort=name' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    const names = body.ngos.map((n: { name: string }) => n.name);
    expect(names).toEqual(['Alpha NGO', 'Midway NGO', 'Zeta NGO']);

    await app.close();
  });

  it('400s on an unknown sort value', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/ngos?sort=invalid' });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('filters by name when q is provided (case-insensitive)', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Save The Oceans', verified: true },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'Plant A Tree', verified: true },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('C'), name: 'Ocean Cleanup Fund', verified: true },
    });

    const response = await app.inject({ method: 'GET', url: '/ngos?q=ocean' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    const names: string[] = body.ngos.map((n: { name: string }) => n.name);
    expect(names).toContain('Save The Oceans');
    expect(names).toContain('Ocean Cleanup Fund');
    expect(names).not.toContain('Plant A Tree');

    await app.close();
  });

  it('returns empty list when q matches nothing', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Green Earth', verified: true },
    });

    const response = await app.inject({ method: 'GET', url: '/ngos?q=zzznomatch' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.ngos).toHaveLength(0);

    await app.close();
  });

  it('400s when q exceeds 100 characters', async () => {
    const app = buildServer();

    const longQ = 'a'.repeat(101);
    const response = await app.inject({ method: 'GET', url: `/ngos?q=${longQ}` });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('GET /ngos/lookup', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('finds the NGO matching the given address', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Impact NGO', verified: true },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/ngos/lookup?address=${ngo.ownerAddress}`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.id).toBe(ngo.id);
    expect(body.name).toBe('Impact NGO');

    await app.close();
  });

  it('404s when no NGO matches the address', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: `/ngos/lookup?address=${fakeAddress('Z')}`,
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('400s on a malformed address instead of matching nothing silently', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/ngos/lookup?address=not-an-address' });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('GET /ngos/:id', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('404s for an id that does not exist', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/ngos/00000000-0000-0000-0000-000000000000',
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('400s for a non-uuid id instead of leaking a Prisma error', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/ngos/not-a-uuid' });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("computes stats from the NGO's streams", async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('C'), name: 'Impact NGO', verified: true },
    });
    const donor = await prisma.donor.create({ data: { address: fakeAddress('D') } });

    await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('E'),
        rate: '10',
        balance: '400',
        withdrawn: '600',
        status: 'ACTIVE',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/ngos/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.stats.totalCommitted).toBe('1000');
    expect(body.stats.totalWithdrawn).toBe('600');
    expect(body.stats.activeStreamCount).toBe(1);
    expect(body.stats.donorCount).toBe(1);

    await app.close();
  });

  it('computes stats correctly with a cancelled stream', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('H'), name: 'Mixed Streams NGO', verified: true },
    });
    const activeDonor = await prisma.donor.create({ data: { address: fakeAddress('I') } });
    const cancelledDonor = await prisma.donor.create({ data: { address: fakeAddress('J') } });

    await prisma.stream.createMany({
      data: [
        {
          onChainId: 2n,
          donorId: activeDonor.id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('K'),
          rate: '10',
          balance: '400',
          withdrawn: '600',
          status: 'ACTIVE',
        },
        {
          onChainId: 3n,
          donorId: cancelledDonor.id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('L'),
          rate: '10',
          balance: '0',
          withdrawn: '200',
          status: 'CANCELLED',
        },
      ],
    });

    const response = await app.inject({ method: 'GET', url: `/ngos/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.stats.totalCommitted).toBe('1200');
    expect(body.stats.totalWithdrawn).toBe('800');
    expect(body.stats.activeStreamCount).toBe(1);
    expect(body.stats.donorCount).toBe(2);

    await app.close();
  });

  it('includes description, website and country from the approved application', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('F'), name: 'Green NGO', verified: true },
    });
    await prisma.ngoApplication.create({
      data: {
        ownerAddress: ngo.ownerAddress,
        name: ngo.name,
        description: 'Saving trees everywhere.',
        website: 'https://green.example',
        contactEmail: 'secret@green.example',
        country: 'Brazil',
        status: 'APPROVED',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/ngos/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.description).toBe('Saving trees everywhere.');
    expect(body.website).toBe('https://green.example');
    expect(body.country).toBe('Brazil');
    expect(body.contactEmail).toBeUndefined();
    expect(body.reviewNote).toBeUndefined();

    await app.close();
  });

  it('returns null description/website/country when there is no approved application', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('G'), name: 'Pending NGO', verified: false },
    });
    await prisma.ngoApplication.create({
      data: {
        ownerAddress: ngo.ownerAddress,
        name: ngo.name,
        description: 'Still under review.',
        contactEmail: 'hi@pending.example',
        status: 'PENDING',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/ngos/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.description).toBeNull();
    expect(body.website).toBeNull();
    expect(body.country).toBeNull();

    await app.close();
  });
});

describe('GET /ngos/:id/donors', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('returns distinct donors with per-NGO committed totals and paginates them', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('H'), name: 'Food Fund', verified: true },
    });
    const otherNgo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('I'), name: 'Other Fund', verified: true },
    });
    const donors = await Promise.all(
      ['J', 'K', 'L'].map((char) =>
        prisma.donor.create({ data: { address: fakeAddress(char) } }),
      ),
    );

    await prisma.stream.createMany({
      data: [
        {
          onChainId: 10n,
          donorId: donors[0].id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('M'),
          rate: '1',
          balance: '40',
          withdrawn: '10',
          status: 'ACTIVE',
        },
        {
          onChainId: 11n,
          donorId: donors[0].id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('M'),
          rate: '1',
          balance: '999',
          withdrawn: '20',
          status: 'CANCELLED',
        },
        {
          onChainId: 12n,
          donorId: donors[1].id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('M'),
          rate: '1',
          balance: '30',
          withdrawn: '5',
          status: 'ACTIVE',
        },
        {
          onChainId: 13n,
          donorId: donors[2].id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('M'),
          rate: '1',
          balance: '7',
          withdrawn: '3',
          status: 'ACTIVE',
        },
        {
          onChainId: 14n,
          donorId: donors[0].id,
          ngoId: otherNgo.id,
          tokenAddress: fakeAddress('M'),
          rate: '1',
          balance: '1000',
          withdrawn: '0',
          status: 'ACTIVE',
        },
      ],
    });

    const first = await app.inject({ method: 'GET', url: `/ngos/${ngo.id}/donors?limit=2` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.donors).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/ngos/${ngo.id}/donors?limit=2&cursor=${firstBody.nextCursor}`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.donors).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();

    const totals = new Map(
      [...firstBody.donors, ...secondBody.donors].map(
        (donor: { id: string; totalCommitted: string }) => [donor.id, donor.totalCommitted],
      ),
    );
    expect(totals).toEqual(
      new Map([
        [donors[0].id, '70'],
        [donors[1].id, '35'],
        [donors[2].id, '10'],
      ]),
    );

    await app.close();
  });

  it('returns 404 for an unknown NGO', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/ngos/00000000-0000-0000-0000-000000000000/donors',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    await app.close();
  });
});
