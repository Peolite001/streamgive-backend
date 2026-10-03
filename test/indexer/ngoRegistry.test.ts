import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { handleNgoRegistryEvent } from '../../src/indexer/handlers/ngoRegistry.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import { addressScVal, makeEvent, stringScVal, symbolScVal } from '../helpers/events.js';

describe('handleNgoRegistryEvent', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('creates an unverified NGO on a register event', async () => {
    const owner = fakeAddress('A');

    await handleNgoRegistryEvent(
      makeEvent([symbolScVal('register'), addressScVal(owner)], stringScVal('Red Cross')),
    );

    const ngo = await prisma.ngo.findUnique({ where: { ownerAddress: owner } });
    expect(ngo?.name).toBe('Red Cross');
    expect(ngo?.verified).toBe(false);

    // A StreamEvent row must be written atomically with the ngo upsert.
    const streamEvent = await prisma.streamEvent.findFirst({ where: { type: 'register' } });
    expect(streamEvent).not.toBeNull();
    expect(streamEvent?.streamId).toBeNull();
    expect(streamEvent?.ledger).toBe(100);
    expect(streamEvent?.payload).toMatchObject({ ownerAddress: owner, name: 'Red Cross' });
  });

  it('marks an existing NGO verified on an approved event', async () => {
    const owner = fakeAddress('B');
    await prisma.ngo.create({ data: { ownerAddress: owner, name: 'Doctors Without Borders' } });

    await handleNgoRegistryEvent(makeEvent([symbolScVal('approved'), addressScVal(owner)], stringScVal('')));

    const ngo = await prisma.ngo.findUnique({ where: { ownerAddress: owner } });
    expect(ngo?.verified).toBe(true);

    // A StreamEvent row must be written atomically with the ngo update.
    const streamEvent = await prisma.streamEvent.findFirst({ where: { type: 'approved' } });
    expect(streamEvent).not.toBeNull();
    expect(streamEvent?.streamId).toBeNull();
    expect(streamEvent?.payload).toMatchObject({ ownerAddress: owner });
  });

  it('is a no-op for an approved event with no matching NGO', async () => {
    const owner = fakeAddress('C');

    // Should not throw even though no NGO row exists for this address —
    // updateMany (not update) is exactly for this case.
    await expect(
      handleNgoRegistryEvent(makeEvent([symbolScVal('approved'), addressScVal(owner)], stringScVal(''))),
    ).resolves.not.toThrow();

    const ngo = await prisma.ngo.findUnique({ where: { ownerAddress: owner } });
    expect(ngo).toBeNull();

    // A StreamEvent is still written even when no NGO row was found —
    // the event happened on-chain regardless.
    const streamEvent = await prisma.streamEvent.findFirst({ where: { type: 'approved' } });
    expect(streamEvent).not.toBeNull();
    expect(streamEvent?.payload).toMatchObject({ ownerAddress: owner });
  });

  it('marks a verified NGO unverified on a revoked event following approval', async () => {
    const owner = fakeAddress('D');
    await prisma.ngo.create({ data: { ownerAddress: owner, name: 'UNICEF' } });

    await handleNgoRegistryEvent(makeEvent([symbolScVal('approved'), addressScVal(owner)], stringScVal('')));
    let ngo = await prisma.ngo.findUnique({ where: { ownerAddress: owner } });
    expect(ngo?.verified).toBe(true);

    await handleNgoRegistryEvent(makeEvent([symbolScVal('revoked'), addressScVal(owner)], stringScVal('')));
    ngo = await prisma.ngo.findUnique({ where: { ownerAddress: owner } });
    expect(ngo?.verified).toBe(false);
  });
});
