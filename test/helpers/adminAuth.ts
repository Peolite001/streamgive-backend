import type { Keypair } from '@stellar/stellar-sdk';

import { sep53Hash } from '../../src/middleware/adminAuth.js';

/** Builds the three headers requireAdminSignature expects, signed for one
 * specific method+url pair — mirrors exactly what the middleware verifies,
 * including the SEP-53 message-signing prefix/hash a real wallet applies.
 *
 * The timestamp must be a Unix epoch timestamp in **milliseconds** (e.g.
 * `Date.now().toString()`), not seconds. Pass the default to avoid unit
 * ambiguity. */
export function signAdminRequest(
  keypair: Keypair,
  method: string,
  url: string,
  timestamp: string = Date.now().toString(),
): Record<string, string> {
  const payload = `${method}:${url}:${timestamp}`;
  // `sign()` returns a Uint8Array, not a Buffer — calling `.toString('base64')`
  // on it straight would hit Array.prototype.toString, which ignores the
  // encoding argument and yields "166,129,8,..." (decimal bytes). That decodes
  // back to garbage, so every signed request would 401. Wrap it first.
  const signature = Buffer.from(keypair.sign(sep53Hash(payload))).toString('base64');

  return {
    'x-admin-address': keypair.publicKey(),
    'x-admin-signature': signature,
    'x-admin-timestamp': timestamp,
  };
}
