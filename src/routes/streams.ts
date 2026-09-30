import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';

const querySchema = z.object({
  // Stellar StrKey ed25519 public key: 'G' + 55 base32 (A-Z2-7) chars.
  donor: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/)
    .optional(),
  ngo: z.string().uuid().optional(),
  // Filter by the NGO's Stellar wallet address instead of its internal UUIT.
  ngoAddress: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/)
    .optional(),
  status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  // A stream id from a previous page's last item; results start right after it.
  cursor: z.string().uuid().optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  // An event id from a previous page's last item; results start right after it.
  cursor: z.string().uuid().optional(),
});

const streamInclude = {
  donor: { select: { address: true } },
  ngo: { select: {id: true, name: true, ownerAddress: true} },
} as const;

// onChainId is a BigInt; Fastify's default JSON.stringify serializer (no
// response schema is defined yet) throws on BigInt, so it has to go out as
// a string.
function serializeStream<T extends { onChainId: bigint; ngo: { name: string } }>(stream: T) {
  const { onChainId, ngo, ...rest } = stream;
  return {
    ...rest,
    onChainId: onChainId.toString(),
    ngo: { ...ngo, name: ngo.name || null, registered: ngo.name !== '' },
  };
}

// ledger is a BigInt and must be stringified the same way as onChainId.
function serializeStreamEvent<T extends { ledger: bigint | null }>(event: T) {
  const { ledger, ...rest } = event;
  return {
    ...rest,
    ledger: ledger === null ? null : ledger.toString(),
  };
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/streams', async (request, reply) => {
    const parsedQuery = querySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }
    // `donor` filters by wallet address (donors have no public directory of
    // their own); `ngo` filters by the NGO's internal id, matching what
    // GET /ngos and /ngos/:id expose; `ngoAddress` filters by the NGO's
    // Stellar wallet address for clients that only have the on-chain key.
    const { donor, ngo, ngoAddress, status, limit, cursor } = parsedQuery.data;

    const rows = await prisma.stream.findMany({
      where: {
        ...(donor ? { donor: { address: donor } } : {}),
        ...(ngo ? { ngoId: ngo } : {}),
        ...(ngoAddress ? { ngo: { ownerAddress: ngoAddress } } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: streamInclude,
    });

    const hasMore = rows.length > limit;
    const streams = hasMore ? rows.slice(0, limit) : rows;

    return { streams: streams.map(serializeStream), hasMore };
  });

  app.get('/streams/:id', async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const stream = await prisma.stream.findUnique({
      where: { id: parsedParams.data.id },
      include: streamInclude,
    });

    if (!stream) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return serializeStream(stream);
  });

  app.get('/streams/:id/activity', async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const parsedQuery = activityQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }

    const { limit, cursor } = parsedQuery.data;

    const stream = await prisma.stream.findUnique({
      where: { id: parsedParams.data.id },
      select: { id: true },
    });

    if (!stream) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const rows = await prisma.streamEvent.findMany({
      where: { streamId: stream.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;

    return { events: events.map(serializeStreamEvent), hasMore };
  });
}
