import { scValToNative } from '@stellar/stellar-sdk';

import { prisma } from '../../db.js';
import { notify } from '../../notifications/service.js';
import type { ContractEvent } from '../worker.js';

/**
 * Entry point for all ngo-registry contract events. Handles `register`,
 * `approved`, and `revoked` from the same function.
 *
 * `register` — emitted when an NGO signs up. Writes: upserts the `ngo` row
 * for the owner address, creating it with `verified: false` or updating its
 * `name` if it already exists. Persists a `StreamEvent` row in the same
 * transaction.
 *
 * `approved` — emitted when an admin approves a previously-registered NGO.
 * Writes: sets `verified: true` on the matching `ngo` row via `updateMany`
 * (not `update`, so a stray `approved` seen without a prior `register` —
 * e.g. the indexer started mid-history — doesn't throw). Persists a
 * `StreamEvent` row in the same transaction.
 *
 * `revoked` — emitted when an admin revokes a previously-approved NGO.
 * Writes: sets `verified: false` on the matching `ngo` row via `updateMany`.
 *
 * All three ultimately mutate the same `ngos` row — `register` creates it
 * unverified, `approved` flips it to verified, and `revoked` flips it back to
 * unverified — so they're handled together rather than split across separate
 * handlers.
 */
export async function handleNgoRegistryEvent(event: ContractEvent): Promise<void> {
  const [topicSymbol, ownerVal] = event.topic;
  const topic = scValToNative(topicSymbol) as string;
  const ownerAddress = scValToNative(ownerVal).toString();

  if (topic === 'register') {
    const name = scValToNative(event.value) as string;
    await prisma.$transaction(async (tx) => {
      await tx.ngo.upsert({
        where: { ownerAddress },
        create: { ownerAddress, name, verified: false },
        update: { name },
      });

      await tx.streamEvent.create({
        data: {
          type: 'register',
          streamId: null,
          ledger: event.ledger,
          txHash: event.txHash,
          payload: { ownerAddress, name },
        },
      });
    });
    return;
  }

  if (topic === 'approved') {
    await prisma.$transaction(async (tx) => {
      await tx.ngo.updateMany({
        where: { ownerAddress },
        data: { verified: true },
      });

      await tx.streamEvent.create({
        data: {
          type: 'approved',
          streamId: null,
          ledger: event.ledger,
          txHash: event.txHash,
          payload: { ownerAddress },
        },
      });
    });

    const ngo = await prisma.ngo.findFirst({ where: { ownerAddress }, select: { id: true } });
    if (ngo) {
      await notify({ type: 'ngo_approved', ownerAddress, ngoId: ngo.id, eventId: event.id });
    }
    return;
  }

  if (topic === 'revoked') {
    await prisma.$transaction(async (tx) => {
      await tx.ngo.updateMany({
        where: { ownerAddress },
        data: { verified: false },
      });

      await tx.streamEvent.create({
        data: {
          type: 'revoked',
          streamId: null,
          ledger: event.ledger,
          txHash: event.txHash,
          payload: { ownerAddress },
        },
      });
    });

    const ngo = await prisma.ngo.findFirst({ where: { ownerAddress }, select: { id: true } });
    if (ngo) {
      await notify({ type: 'ngo_revoked', ownerAddress, ngoId: ngo.id, eventId: event.id });
    }
  }
}
