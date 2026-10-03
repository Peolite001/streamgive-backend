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
  // Filter by the NGO's Stellar wallet address instead of its internal UUID.
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

const streamInclude = {
  donor: { select: { address: true } },
  ngo: { select: { id: true, name: true, ownerAddress: true } },
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

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/streams',
    {
      schema: {
        tags: ['Streams'],
        summary: 'List donation streams',
        description: 'Returns streams newest first, with optional filters and cursor pagination.',
        querystring: {
          type: 'object',
          properties: {
            donor: { type: 'string', pattern: '^G[A-Z2-7]{55}$' },
            ngo: { type: 'string', format: 'uuid' },
            ngoAddress: { type: 'string', pattern: '^G[A-Z2-7]{55}$' },
            status: { type: 'string', enum: ['ACTIVE', 'CANCELLED'] },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
            cursor: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
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

      return {
        streams: streams.map(serializeStream),
        hasMore,
        nextCursor: hasMore ? (streams.at(-1)?.id ?? null) : null,
      };
    },
  );

  app.get(
    '/streams/:id',
    {
      schema: {
        tags: ['Streams'],
        summary: 'Get a donation stream',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
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
    },
  );
}
