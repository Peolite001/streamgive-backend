import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { sendPublicCacheable } from './cacheable.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';

const idParamSchema = z.object({ id: z.string().uuid() });
const RECENT_STREAMS_LIMIT = 10;

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

const adminListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
  // Optional boolean filter as a query string (so 'true'/'false' arrive as
  // strings); omitted means "everything, verified or not".
  verified: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

/** Builds the GET /ngos/:id response shape from a unique Prisma `where`. */
async function findNgoDetail(where: { id: string } | { ownerAddress: string }) {
  const ngo = await prisma.ngo.findUnique({ where });

  if (!ngo) {
    return null;
  }

  const [approvedApp, streamStats, recentStreamRows] = await Promise.all([
    prisma.ngoApplication.findFirst({
      where: { ownerAddress: ngo.ownerAddress, status: 'APPROVED' },
      orderBy: { updatedAt: 'desc' },
      select: { description: true, website: true, country: true },
    }),
    prisma.$queryRaw<
      Array<{
        totalCommitted: string;
        totalWithdrawn: string;
        activeStreamCount: number;
        donorCount: number;
      }>
    >`
      SELECT
        COALESCE(SUM(
          CASE
            WHEN "status" = 'CANCELLED' THEN "withdrawn"::numeric
            ELSE "balance"::numeric + "withdrawn"::numeric
          END
        ), 0)::text AS "totalCommitted",
        COALESCE(SUM("withdrawn"::numeric), 0)::text AS "totalWithdrawn",
        COUNT(*) FILTER (WHERE "status" = 'ACTIVE')::int AS "activeStreamCount",
        COUNT(DISTINCT "donor_id")::int AS "donorCount"
      FROM "streams"
      WHERE "ngo_id" = ${ngo.id}
    `,
    prisma.stream.findMany({
      where: { ngoId: ngo.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECENT_STREAMS_LIMIT + 1,
      select: {
        id: true,
        onChainId: true,
        donor: { select: { address: true } },
        tokenAddress: true,
        rate: true,
        balance: true,
        withdrawn: true,
        status: true,
        createdAt: true,
      },
    }),
  ]);

  const [stats] = streamStats;
  const hasMoreRecentStreams = recentStreamRows.length > RECENT_STREAMS_LIMIT;
  const recentStreams = recentStreamRows.slice(0, RECENT_STREAMS_LIMIT);

  return {
    ...ngo,
    name: ngo.name || null,
    registered: ngo.name !== '',
    description: approvedApp?.description ?? null,
    website: approvedApp?.website ?? null,
    country: approvedApp?.country ?? null,
    stats: {
      totalCommitted: stats.totalCommitted,
      totalWithdrawn: stats.totalWithdrawn,
      activeStreamCount: stats.activeStreamCount,
      donorCount: stats.donorCount,
    },
    recentStreams: recentStreams.map(({ onChainId, ...stream }) => ({
      ...stream,
      onChainId: onChainId.toString(),
    })),
    recentStreamsNextCursor: hasMoreRecentStreams ? recentStreams.at(-1)?.id ?? null : null,
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

  // Admin counterpart to GET /ngos above: also returns the unverified rows
  // the indexer creates (a `register` event, or a stream to an address that
  // never registered) — exactly what an admin needs to spot streams pointed
  // at NGOs that aren't in the public directory. Optionally narrowed with
  // ?verified=true|false.
  app.get('/ngos/all', { preHandler: requireAdminSignature }, async (request, reply) => {
    const parsedQuery = adminListQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }
    const { limit, cursor, verified } = parsedQuery.data;

    const rows = await prisma.ngo.findMany({
      where: verified === undefined ? {} : { verified },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasMore = rows.length > limit;
    const ngos = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? ngos[ngos.length - 1].id : null;

    return { ngos, nextCursor };
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
