import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { sendPublicCacheable } from './cacheable.js';

const idParamSchema = z.object({ id: z.string().uuid() });

const sortSchema = z.enum(['newest', 'oldest', 'name']).default('newest');

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
  sort: sortSchema,
  // Name search: case-insensitive substring match, capped to prevent abuse.
  q: z.string().max(100).optional(),
});

const donorListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
});

function committedAmount(stream: {
  status: 'ACTIVE' | 'CANCELLED';
  balance: string;
  withdrawn: string;
}): bigint {
  return stream.status === 'CANCELLED'
    ? BigInt(stream.withdrawn)
    : BigInt(stream.balance) + BigInt(stream.withdrawn);
}

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
    (sum, stream) => sum + committedAmount(stream),
    0n,
  );
  const totalWithdrawn = streams.reduce((sum, s) => sum + BigInt(s.withdrawn), 0n);

  return {
    ...profile,
    name: profile.name || null,
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
    const nextCursor = hasMore ? ngos[ngos.length - 1].id : null;

    return sendPublicCacheable(request, reply, { ngos, nextCursor });
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

    return sendPublicCacheable(request, reply, ngo);
  });

  app.get('/ngos/:id/donors', async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    const parsedQuery = donorListQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const { id: ngoId } = parsedParams.data;
    const { limit, cursor } = parsedQuery.data;
    const ngo = await prisma.ngo.findUnique({ where: { id: ngoId }, select: { id: true } });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const rows = await prisma.donor.findMany({
      where: { streams: { some: { ngoId } } },
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        address: true,
        streams: {
          where: { ngoId },
          select: { status: true, balance: true, withdrawn: true },
        },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const donors = page.map(({ streams, ...donor }) => ({
      ...donor,
      totalCommitted: streams
        .reduce((sum, stream) => sum + committedAmount(stream), 0n)
        .toString(),
    }));

    return {
      donors,
      nextCursor: hasMore ? donors[donors.length - 1].id : null,
    };
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

    return sendPublicCacheable(request, reply, ngo);
  });
}
