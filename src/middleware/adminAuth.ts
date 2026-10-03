import { Keypair } from '@stellar/stellar-sdk';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** ed25519 signatures are always 64 bytes. A decode that yields any other
 * length means the encoding guess was wrong, not that the key was. */
const ED25519_SIGNATURE_BYTES = 64;

// SEP-53 ("Sign and Verify Messages"): a wallet's generic message-signing
// call doesn't sign the raw bytes you hand it — it signs
// SHA256(prefix + message), where the fixed prefix below stops a message
// signature from ever being mistaken for (or replayed as) a transaction
// signature. Skipping this prefix/hash step, which the initial version of
// this file did, means the verification below would never succeed against
// a real wallet's signature.
const SEP53_PREFIX = 'Stellar Signed Message:\n';

const usedSignatures = new Map<string, number>();

/** Exported so tests can sign fixtures the same way a real wallet would,
 * rather than re-deriving (and risking drift from) this exact construction. */
export function sep53Hash(message: string): Buffer {
  const encoded = Buffer.concat([
    Buffer.from(SEP53_PREFIX, 'utf-8'),
    Buffer.from(message, 'utf-8'),
  ]);
  return createHash('sha256').update(encoded).digest();
}

/**
 * Verifies the caller controls ADMIN_ADDRESS's keypair, without a private
 * key ever crossing the wire: the client signs
 * `${method}:${url}:${timestamp}` with their Stellar wallet (via its
 * generic message-signing call, not transaction-signing) and sends the
 * pieces as headers. The timestamp both binds the signature to this one
 * request and bounds replay — a captured header set is only useful for a
 * few minutes.
 */
export async function requireAdminSignature(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Read per-request, not cached at module load: env vars set after this
  // module is first imported (as tests do, in beforeAll) would otherwise
  // never be seen, since a module-level const only evaluates once.
  const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS;

  if (!ADMIN_ADDRESS) {
    reply.code(503).send({ error: 'admin_auth_not_configured' });
    return;
  }

  const address = request.headers['x-admin-address'];
  const signatureB64 = request.headers['x-admin-signature'];
  const timestampHeader = request.headers['x-admin-timestamp'];

  if (
    typeof address !== 'string' ||
    typeof signatureB64 !== 'string' ||
    typeof timestampHeader !== 'string'
  ) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }

  if (address !== ADMIN_ADDRESS) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
    reply.code(401).send({ error: 'stale_signature' });
    return;
  }

  const payload = `${request.method}:${request.url}:${timestampHeader}`;

  try {
    const keypair = Keypair.fromPublicKey(address);
    const hash = sep53Hash(payload);

    // SEP-53 pins down what gets signed, but not how the wallet hands the
    // signature back, and wallets differ: some return base64, some hex.
    // Trying both costs nothing in trust — the signature still has to
    // verify against ADMIN_ADDRESS either way — and avoids an opaque 401
    // that looks identical to a genuinely forged one.
    const candidates: Array<[string, Buffer]> = [
      ['base64', Buffer.from(signatureB64, 'base64')],
      ['hex', Buffer.from(signatureB64, 'hex')],
    ];

    const replayKey = `${address}:${timestampHeader}`;
    const now = Date.now();
    for (const [key, seenAt] of usedSignatures) {
      if (now - seenAt > MAX_CLOCK_SKEW_MS) usedSignatures.delete(key);
    }
    if (usedSignatures.has(replayKey)) {
      reply.code(401).send({ error: 'replayed_signature' });
      return;
    }

    const matched = candidates.find(
      ([, sig]) => sig.length === ED25519_SIGNATURE_BYTES && keypair.verify(hash, sig),
    );

    if (!matched) {
      request.log.warn(
        {
          payload,
          signatureChars: signatureB64.length,
          base64Bytes: candidates[0][1].length,
          hexBytes: candidates[1][1].length,
        },
        'admin signature did not verify',
      );
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    usedSignatures.set(replayKey, now);
  } catch (err) {
    request.log.warn({ err }, 'admin signature check threw');
    reply.code(401).send({ error: 'unauthorized' });
  }
}
