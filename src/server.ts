import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';

import { prisma } from './db.js';
import { impactRoutes } from './routes/impact.js';
import { ngoApplicationRoutes } from './routes/ngoApplications.js';
import { ngoRoutes } from './routes/ngos.js';
import { streamRoutes } from './routes/streams.js';

// pino-pretty runs its formatting on a separate worker thread; spawning
// one per Fastify instance is fine for a single long-running process, but
// the test suite calls buildServer() dozens of times, so it's skipped for
// NODE_ENV=test (which Vitest sets by default) as well as production.
const USE_PRETTY_LOGS = !['production', 'test'].includes(process.env.NODE_ENV ?? '');

export function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Structured JSON otherwise (production: for log aggregation; test:
      // to avoid the worker-thread overhead above) — pino-pretty is a
      // devDependency on purpose, since the production image never needs it.
      transport: USE_PRETTY_LOGS ? { target: 'pino-pretty' } : undefined,
    },
  });

  app.register(swagger, {
    openapi: {
      info: {
        title: 'StreamGive API',
        description: 'Public API for StreamGive streams, NGOs, and impact data.',
        version: '1.0.0',
      },
      tags: [
        { name: 'Health', description: 'Service health' },
        { name: 'Streams', description: 'Public donation stream data' },
        { name: 'NGOs', description: 'Public NGO directory and profiles' },
        { name: 'Impact', description: 'Public platform and NGO impact metrics' },
      ],
    },
  });

  if (process.env.NODE_ENV !== 'production') {
    app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    });
  }

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const statusCode =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
    const errorString =
      statusCode === 404
        ? 'not_found'
        : statusCode === 400
          ? 'invalid_request'
          : 'internal_server_error';
    reply.code(statusCode).send({ error: errorString });
  });

  // The browser app runs on a different origin to this API (a different
  // port in development, a different host in deployment), so every call
  // from it is cross-origin and fails as an opaque "Failed to fetch"
  // without these headers.
  //
  // Allowed origins are an explicit list, not a wildcard: the admin routes
  // authenticate with a signature the browser sends as a header, so any
  // origin allowed here can ask a signed-in admin's browser to call them.
  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  app.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-admin-address', 'x-admin-signature', 'x-admin-timestamp'],
  });

  app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 100),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
  });

  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Check API and database health',
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string', const: 'ok' } },
            required: ['status'],
          },
        },
      },
    },
    async () => {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    },
  );

  app.register(ngoRoutes);
  app.register(streamRoutes);
  app.register(impactRoutes);
  app.register(ngoApplicationRoutes);

  return app;
}
