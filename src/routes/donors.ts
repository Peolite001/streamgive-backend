import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';

const querySchema = z.object({
  sort: z.enum(['committed', 'withdrawn']).default('committed'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
});

// Stellar StrKey ed25519 public key: 'G' + 55 base32 (A-Z2-7) chars.
const addressParamSchema = z.object({
  address: z.string().regex(/^G[A-Z2-7]{55}$/),
});

export async function donorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/donors', async (request, reply) => {
    const parsedQuery = querySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }

    const { sort, order, limit, cursor } = parsedQuery.data;
    const rows = await prisma.donor.findMany({
      include: {
        streams: { select: { balance: true, withdrawn: true, status: true } },
      },
    });

    const ranked = rows
      .map(({ streams, ...donor }) => ({
        ...donor,
        totalCommitted: streams
          .reduce(
            (sum, stream) =>
              stream.status === 'CANCELLED'
                ? sum + BigInt(stream.withdrawn)
                : sum + BigInt(stream.balance) + BigInt(stream.withdrawn),
            0n,
          )
          .toString(),
        totalWithdrawn: streams
          .reduce((sum, stream) => sum + BigInt(stream.withdrawn), 0n)
          .toString(),
      }))
      .sort((left, right) => {
        const leftValue = BigInt(sort === 'committed' ? left.totalCommitted : left.totalWithdrawn);
        const rightValue = BigInt(
          sort === 'committed' ? right.totalCommitted : right.totalWithdrawn,
        );
        const comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;

        if (comparison !== 0) return order === 'asc' ? comparison : -comparison;
        return left.id.localeCompare(right.id);
      });

    const cursorIndex = cursor ? ranked.findIndex((donor) => donor.id === cursor) : -1;
    if (cursor && cursorIndex === -1) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const start = cursorIndex + 1;
    const page = ranked.slice(start, start + limit + 1);
    const hasMore = page.length > limit;
    const donors = hasMore ? page.slice(0, limit) : page;

    return {
      donors,
      nextCursor: hasMore ? donors[donors.length - 1].id : null,
    };
  });

  // Per-donor summary so the dashboard (and other clients) can show donor
  // stats without paging through every stream and summing in the browser.
  app.get('/donors/:address', async (request, reply) => {
    const parsedParams = addressParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const donor = await prisma.donor.findUnique({
      where: { address: parsedParams.data.address },
      include: {
        streams: {
          select: { ngoId: true, balance: true, withdrawn: true, status: true },
        },
      },
    });

    if (!donor) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const { streams, ...rest } = donor;

    // A cancelled stream's remaining balance is no longer committed; only what
    // it already paid out counts, matching GET /donors.
    const totalCommitted = streams
      .reduce(
        (sum, stream) =>
          stream.status === 'CANCELLED'
            ? sum + BigInt(stream.withdrawn)
            : sum + BigInt(stream.balance) + BigInt(stream.withdrawn),
        0n,
      )
      .toString();
    const totalWithdrawn = streams
      .reduce((sum, stream) => sum + BigInt(stream.withdrawn), 0n)
      .toString();

    return {
      ...rest,
      totalCommitted,
      totalWithdrawn,
      activeStreamCount: streams.filter((stream) => stream.status === 'ACTIVE').length,
      distinctNgoCount: new Set(streams.map((stream) => stream.ngoId)).size,
    };
  });
}
