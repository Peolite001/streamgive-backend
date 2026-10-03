import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';

import { prisma } from './db.js';
import { donorRoutes } from './routes/donors.js';
import { indexerStatusRoutes } from './routes/indexerStatus.js';
import { impactRoutes } from './routes/impact.js';
import { ngoApplicationRoutes } from './routes/ngoApplications.js';
import { ngoRoutes } from './routes/ngos.js';
import { streamRoutes } from './routes/streams.js';

// pino-pretty runs its formatting on a separate worker thread; spawning
// one per Fastify instance is fine for a single long-running process, but
// the test suite calls buildServer() dozens of times, so it's skipped for
// NODE_ENV=test (which Vitest sets by default) as well as production.
const USE_PRETTY_LOGS = !['production', 'test'].includes(process.env.NODE_ENV ?? '');

export type TrustProxySetting =
  boolean | string | string[] | ((address: string, hop: number) => boolean);

/**
 * Parses the TRUST_PROXY environment variable into a valid Fastify trustProxy configuration.
 *
 * Behind a reverse proxy (such as Render's load balancer or Cloudflare), Fastify's
 * socket.remoteAddress is the proxy's IP. Without trustProxy enabled, @fastify/rate-limit
 * keys all clients to that single proxy IP, throttling all users collectively.
 *
 * Supported values:
 * - undefined or empty: defaults to `true` (enabling proxy trust by default behind Render)
 * - 'true': trusts all proxies, reading client IP from the first entry of X-Forwarded-For
 * - 'false': disables proxy trust, using socket remoteAddress
 * - integer string (e.g. '1', '2'): bounded hop count function trusting the specified number of proxy hops
 * - comma-separated list or single string: IP or CIDR ranges to trust
 */
export function parseTrustProxy(value: string | undefined): TrustProxySetting {
  if (value === undefined || value.trim() === '') {
    return true;
  }
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }
  const num = Number(trimmed);
  if (!Number.isNaN(num) && Number.isInteger(num)) {
    if (num <= 0) {
      return false;
    }
    return (_address: string, hop: number) => hop < num;
  }
  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return trimmed;
}

export interface BuildServerOptions {
  trustProxy?: TrustProxySetting;
}

export function buildServer(options?: BuildServerOptions) {
  const trustProxySetting =
    options?.trustProxy !== undefined
      ? options.trustProxy
      : parseTrustProxy(process.env.TRUST_PROXY);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Structured JSON otherwise (production: for log aggregation; test:
      // to avoid the worker-thread overhead above) — pino-pretty is a
      // devDependency on purpose, since the production image never needs it.
      transport: USE_PRETTY_LOGS ? { target: 'pino-pretty' } : undefined,
    },
    trustProxy: trustProxySetting,
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

  app.setErrorHandler<Error & { statusCode?: number }>((error, request, reply) => {
    request.log.error(error);
    const candidateStatusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const statusCode =
      typeof candidateStatusCode === 'number' &&
      candidateStatusCode >= 400 &&
      candidateStatusCode < 600
        ? candidateStatusCode
        : 500;
    const errorString =
      statusCode === 404
        ? 'not_found'
        : statusCode === 400
          ? 'invalid_request'
          : 'internal_server_error';
    reply.code(statusCode).send({ error: errorString });
  });

  // Register helmet for security headers
  app.register(helmet, {
    contentSecurityPolicy: false, // Disabled for API-only server
    global: true,
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
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (_request, reply) => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return { status: 'ok' };
      } catch {
        return reply.code(503).send({ status: 'error', database: 'unreachable' });
      }
    },
  );

  app.register(ngoRoutes);
  app.register(donorRoutes);
  app.register(streamRoutes);
  app.register(impactRoutes);
  app.register(ngoApplicationRoutes);
  app.register(indexerStatusRoutes);

  return app;
}
