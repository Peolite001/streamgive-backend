import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';

const idParamSchema = z.object({ id: z.string().uuid() });

const updateNgoSchema = z.object({
  displayName: z.string().nullable().optional(),
});

const sortSchema = z.enum(['newest', 'oldest', 'name']).default('newest');

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
  sort: sortSchema,
  // Name search: case-insensitive substring match, capped to prevent abuse.
  q: z.string().max(100).optional(),
});

const lookupQuerySchema = z.object({
  // Stellar StrKey ed25519 public key: 'G' + 55 base32 (A-Z2-7) chars.
  address: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/),
});

/** Builds the GET /ngos/:id response shape from a unique Prisma `where`. */
async function findNgoDetail(where: { id: string } | { ownerAddress: string }) {
  const ngo = await prisma.ngo.findUnique({
    where,
    include: {
      streams: {
        select: { donorId: true, status: true, balance: true, withdrawn: true },
      },
    },
  });

  if (!ngo) {
    return null;
  }

  const approvedApp = await prisma.ngoApplication.findFirst({
    where: { ownerAddress: ngo.ownerAddress, status: 'APPROVED' },
    orderBy: { updatedAt: 'desc' },
    select: { description: true, website: true, country: true },
  });

  const { streams, ...profile } = ngo;

  // For an active stream, balance + withdrawn equals the total deposited and
  // committed to this NGO (balance will eventually be withdrawn; withdrawn
  // already has been).  For a cancelled stream the contract zeroes balance
  // and refunds it to the donor, so only the already-withdrawn portion was
  // ever delivered to the NGO.  Counting balance on a cancelled stream would
  // overstate totalCommitted by the refunded amount.
  const totalCommitted = streams.reduce(
    (sum, s) =>
      s.status === 'CANCELLED'
        ? sum + BigInt(s.withdrawn)
        : sum + BigInt(s.balance) + BigInt(s.withdrawn),
    0n,
  );
  const totalWithdrawn = streams.reduce((sum, s) => sum + BigInt(s.withdrawn), 0n);

  return {
    ...profile,
    name: profile.displayName || profile.name || null,
    registered: profile.name !== '',
    description: approvedApp?.description ?? null,
    website: approvedApp?.website ?? null,
    country: approvedApp?.country ?? null,
    stats: {
      totalCommitted: totalCommitted.toString(),
      totalWithdrawn: totalWithdrawn.toString(),
      activeStreamCount: streams.filter((s) => s.status === 'ACTIVE').length,
      donorCount: new Set(streams.map((s) => s.donorId)).size,
    },
  };
}

export async function ngoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ngos', async (request, reply) => {
    const parsedQuery = listQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }
    const { limit, cursor, sort, q } = parsedQuery.data;

    const orderBy: { createdAt: 'asc' | 'desc' } | { name: 'asc' } =
      sort === 'oldest'
        ? { createdAt: 'asc' }
        : sort === 'name'
          ? { name: 'asc' }
          : { createdAt: 'desc' };

    const rows = await prisma.ngo.findMany({
      where: {
        verified: true,
        ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      },
      orderBy,
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasMore = rows.length > limit;
    const ngos = hasMore ? rows.slice(0, limit) : rows;
    const mappedNgos = ngos.map((ngo) => ({
      ...ngo,
      name: ngo.displayName || ngo.name,
    }));
    const nextCursor = hasMore ? ngos[ngos.length - 1].id : null;

    return { ngos: mappedNgos, nextCursor };
  });

  app.get('/ngos/lookup', async (request, reply) => {
    const parsedQuery = lookupQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }

    const ngo = await findNgoDetail({ ownerAddress: parsedQuery.data.address });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return ngo;
  });

  app.get('/ngos/:id', async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const ngo = await findNgoDetail({ id: parsedParams.data.id });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return ngo;
  });

  app.patch('/admin/ngos/:id', { preHandler: requireAdminSignature }, async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const parsedBody = updateNgoSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsedBody.error.flatten() });
    }

    const ngo = await prisma.ngo.findUnique({ where: { id: parsedParams.data.id } });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const updated = await prisma.ngo.update({
      where: { id: ngo.id },
      data: { displayName: parsedBody.data.displayName },
    });

    return { ...updated, name: updated.displayName || updated.name };
  });
}
