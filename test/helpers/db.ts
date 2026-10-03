import { Keypair } from '@stellar/stellar-sdk';

import { prisma } from '../../src/db.js';

/** Truncates every table. Call between tests so fixtures never leak across them. */
export async function resetDb(): Promise<void> {
  await prisma.notificationLog.deleteMany();
  await prisma.streamEvent.deleteMany();
  await prisma.stream.deleteMany();
  await prisma.donor.deleteMany();
  await prisma.ngo.deleteMany();
  await prisma.ngoApplication.deleteMany();
  await prisma.indexerCheckpoint.deleteMany();
  await prisma.indexerDeadLetter.deleteMany();
}

/**
 * A real, checksum-valid Stellar G-address, derived deterministically from
 * `distinguishingChar` so a given letter always yields the same address and
 * distinct letters yield distinct ones.
 *
 * These used to be `G` + the letter repeated 55 times. That satisfies the
 * `^G[A-Z2-7]{55}$` shape our route validation checks, but it isn't valid
 * StrKey — so anything that actually decodes an address (`new Address(...)`
 * in the event fixtures, for one) rejected it outright. Deriving from a
 * filled seed keeps the "no fixture management" convenience while producing
 * addresses that survive real decoding.
 */
export function fakeAddress(distinguishingChar: string): string {
  const seed = Buffer.alloc(32, distinguishingChar.toUpperCase().charCodeAt(0));
  return Keypair.fromRawEd25519Seed(seed).publicKey();
}