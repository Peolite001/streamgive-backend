import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';

const paramsSchema = z.object({ ngoId: z.string().uuid() });

/**
 * Public "impact" view for one NGO — a superset of /ngos/:id's profile
 * stats, framed around relative impact rather than admin/profile detail:
 * active vs. cancelled breakdown, and this NGO's share of everything ever
 * committed platform-wide. That platform-wide comparison is the reason
 * this isn't just folded into /ngos/:id — a plain profile page shouldn't
 * need to scan every stream on the platform to render.
 */
export async function impactRoutes(app: FastifyInstance): Promise<void> {
  app.get('/impact', async () => {
    const [streams, verifiedNgoCount] = await Promise.all([
      prisma.stream.findMany({ select: { balance: true, withdrawn: true, status: true } }),
      prisma.ngo.count({ where: { verified: true } }),
    ]);

    // For cancelled streams the balance was refunded to the donor and never
    // delivered to any NGO, so only count withdrawn.  Active streams count
    // balance + withdrawn (balance will be withdrawn in the future).
    const totalCommitted = streams.reduce(
      (sum, s) =>
        s.status === 'CANCELLED'
          ? sum + BigInt(s.withdrawn)
          : sum + BigInt(s.balance) + BigInt(s.withdrawn),
      0n,
    );
    const totalWithdrawn = streams.reduce((sum, s) => sum + BigInt(s.withdrawn), 0n);
    const activeStreams = streams.filter((s) => s.status === 'ACTIVE').length;

    return {
      totalCommitted: totalCommitted.toString(),
      totalWithdrawn: totalWithdrawn.toString(),
      activeStreams,
      verifiedNgoCount,
    };
  });

  app.get('/impact/:ngoId', async (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const { ngoId } = parsedParams.data;

    const ngo = await prisma.ngo.findUnique({
      where: { id: ngoId },
      include: {
        streams: { select: { status: true, balance: true, withdrawn: true, donorId: true } },
      },
    });

    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // For cancelled streams the balance was refunded to the donor, so only
    // count withdrawn.  Active streams count balance + withdrawn.
    const ngoCommitted = ngo.streams.reduce(
      (sum, s) =>
        s.status === 'CANCELLED'
          ? sum + BigInt(s.withdrawn)
          : sum + BigInt(s.balance) + BigInt(s.withdrawn),
      0n,
    );
    const ngoWithdrawn = ngo.streams.reduce((sum, s) => sum + BigInt(s.withdrawn), 0n);

    // Scans every stream on the platform — fine at MVP scale, but this is
    // the first thing to replace with a maintained running total if the
    // streams table grows large.
    const allStreams = await prisma.stream.findMany({
      select: { balance: true, withdrawn: true, status: true },
    });
    const platformCommitted = allStreams.reduce(
      (sum, s) =>
        s.status === 'CANCELLED'
          ? sum + BigInt(s.withdrawn)
          : sum + BigInt(s.balance) + BigInt(s.withdrawn),
      0n,
    );

    // Guard against division by zero when platform has no committed streams (#89)
    const platformSharePercent =
      platformCommitted > 0n ? (Number(ngoCommitted) * 100) / Number(platformCommitted) : 0;

    return {
      ngoId: ngo.id,
      name: ngo.name,
      totalCommitted: ngoCommitted.toString(),
      totalWithdrawn: ngoWithdrawn.toString(),
      activeStreams: ngo.streams.filter((s) => s.status === 'ACTIVE').length,
      cancelledStreams: ngo.streams.filter((s) => s.status === 'CANCELLED').length,
      uniqueDonors: new Set(ngo.streams.map((s) => s.donorId)).size,
      platformSharePercent,
    };
  });
}
