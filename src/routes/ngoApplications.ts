import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';

const applicationSchema = z.object({
  ownerAddress: z.string().regex(/^G[A-Z2-7]{55}$/),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  website: z.string().url().optional(),
  contactEmail: z.string().email(),
  country: z.string().max(100).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const statusQuerySchema = z.object({
  // Stellar StrKey ed25519 public key: 'G' + 55 base32 (A-Z2-7) chars.
  // Same regex as GET /ngos/lookup.
  ownerAddress: z.string().regex(/^G[A-Z2-7]{55}$/),
});

const reviewBodySchema = z.object({
  reviewNote: z.string().max(2000).optional(),
});

export async function ngoApplicationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/ngo-applications',
    // Public write endpoint — tighter than the global default since it's
    // the most spam-prone route in the API.
    {
      config: {
        rateLimit: {
          max: Number(process.env.RATE_LIMIT_APPLICATION_MAX ?? 5),
          timeWindow: process.env.RATE_LIMIT_APPLICATION_WINDOW ?? '1 minute',
        },
      },
    },
    async (request, reply) => {
      const parsed = applicationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const existingApp = await prisma.ngoApplication.findFirst({
        where: {
          ownerAddress: parsed.data.ownerAddress,
          status: { in: ['PENDING', 'APPROVED'] },
        },
      });
      if (existingApp) {
        if (existingApp.status === 'APPROVED') {
          return reply.code(409).send({ error: 'already_approved' });
        }
        return reply.code(409).send({ error: 'application_already_pending' });
      }

      const application = await prisma.ngoApplication.create({ data: parsed.data });
      return reply.code(201).send(application);
    },
  );

  // Public read endpoint: an applicant can check their own review status
  // without an admin signature. Deliberately returns only the review
  // outcome and timestamps — never the contact details or description
  // submitted with the application, since anyone who knows (or guesses) an
  // address could otherwise read them.
  app.get(
    '/ngo-applications/status',
    {
      schema: {
        tags: ['NGOs'],
        summary: 'Check an NGO application status',
        description: 'Returns only the status and timestamps for the supplied owner address.',
        querystring: {
          type: 'object',
          properties: { ownerAddress: { type: 'string', pattern: '^G[A-Z2-7]{55}$' } },
          required: ['ownerAddress'],
        },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request, reply) => {
      const parsed = statusQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const application = await prisma.ngoApplication.findFirst({
        where: { ownerAddress: parsed.data.ownerAddress },
        orderBy: { createdAt: 'desc' },
        select: { status: true, createdAt: true, updatedAt: true },
      });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }

      return application;
    },
  );

  app.get('/ngo-applications', { preHandler: requireAdminSignature }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    const where = parsed.data.status ? { status: parsed.data.status } : {};

    const [applications, total] = await Promise.all([
      prisma.ngoApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parsed.data.limit,
        skip: parsed.data.offset,
      }),
      prisma.ngoApplication.count({ where }),
    ]);

    return { applications, total, limit: parsed.data.limit, offset: parsed.data.offset };
  });

  app.get(
    '/ngo-applications/:id',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const application = await prisma.ngoApplication.findUnique({
        where: { id: parsedParams.data.id },
      });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }

      return application;
    },
  );

  app.post(
    '/ngo-applications/:id/approve',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { id } = parsedParams.data;

      const parsed = reviewBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      try {
        return await prisma.ngoApplication.update({
          where: { id },
          data: { status: 'APPROVED', reviewNote: parsed.data.reviewNote },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ error: 'already_reviewed' });
      }

      return await prisma.ngoApplication.update({
        where: { id },
        data: { status: 'APPROVED', reviewNote: parsed.data.reviewNote },
      });
    },
  );

  app.post(
    '/ngo-applications/:id/reject',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { id } = parsedParams.data;

      const parsed = reviewBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      try {
        return await prisma.ngoApplication.update({
          where: { id },
          data: { status: 'REJECTED', reviewNote: parsed.data.reviewNote },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ error: 'already_reviewed' });
      }

      return await prisma.ngoApplication.update({
        where: { id },
        data: { status: 'REJECTED', reviewNote: parsed.data.reviewNote },
      });
    },
  );
}
