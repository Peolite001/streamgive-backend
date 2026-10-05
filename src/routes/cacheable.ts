import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const PUBLIC_MAX_AGE_SECONDS = 30;

function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  const candidates = Array.isArray(header) ? header : header?.split(',') ?? [];
  return candidates.some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, '');
    return normalized === '*' || normalized === etag;
  });
}

/** Send a public JSON representation with a validator and short shared-cache lifetime. */
export function sendPublicCacheable<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: T,
): FastifyReply {
  const body = JSON.stringify(payload) ?? '';
  const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;

  reply
    .header('Cache-Control', `public, max-age=${PUBLIC_MAX_AGE_SECONDS}, stale-while-revalidate=60`)
    .header('ETag', etag);

  if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
    return reply.code(304).send();
  }

  return reply.send(payload);
}
