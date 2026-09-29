import { xdr } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { handleDonationVaultEvent } from '../../src/indexer/handlers/donationVault.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import { addressScVal, i128ScVal, makeEvent, symbolScVal, u64ScVal } from '../helpers/events.js';

describe('handleDonationVaultEvent', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('creates a stream (and placeholder donor/ngo rows) on a created event', async () => {
    const donor = fakeAddress('A');
    const ngo = fakeAddress('B');
    const token = fakeAddress('C');

    const closedAt = '2024-01-15T12:00:00.000Z';
    const event = makeEvent(
      [symbolScVal('created'), u64ScVal(1n)],
      xdr.ScVal.scvVec([
        addressScVal(donor),
        addressScVal(ngo),
        addressScVal(token),
        i128ScVal(1000n),
        i128ScVal(10n),
      ]),
      { ledgerClosedAt: closedAt },
    );

    await handleDonationVaultEvent(event);

    const stream = await prisma.stream.findUnique({ where: { onChainId: 1n } });
    expect(stream?.balance).toBe('1000');
    expect(stream?.rate).toBe('10');
    expect(stream?.withdrawn).toBe('0');
    expect(stream?.status).toBe('ACTIVE');
    expect(stream?.createdAt.toISOString()).toBe(new Date(closedAt).toISOString());

    expect(await prisma.donor.findUnique({ where: { address: donor } })).not.toBeNull();

    // Never went through ngo-registry — placeholder, unverified.
    const ngoRow = await prisma.ngo.findUnique({ where: { ownerAddress: ngo } });
    expect(ngoRow?.verified).toBe(false);

    // A StreamEvent row must be written atomically with the stream upsert.
    const streamEvent = await prisma.streamEvent.findFirst({ where: { type: 'created' } });
    expect(streamEvent).not.toBeNull();
    expect(streamEvent?.streamId).toBe(1n);
    expect(streamEvent?.ledger).toBe(100);
    expect(streamEvent?.txHash).toBe(
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    );
    expect(streamEvent?.payload).toMatchObject({
      deposit: '1000',
      rate: '10',
    });
  });

  it('applies a withdraw event as a balance/withdrawn delta', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('D') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('E'), name: 'NGO E' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 2n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('F'),
        rate: '10',
        balance: '1000',
        withdrawn: '0',
      },
    });

    await handleDonationVaultEvent(makeEvent([symbolScVal('withdraw'), u64ScVal(2n)], i128ScVal(500n)));

    const stream = await prisma.stream.findUnique({ where: { onChainId: 2n } });
    expect(stream?.balance).toBe('500');
    expect(stream?.withdrawn).toBe('500');

    // A StreamEvent row must be written atomically with the stream update.
    const streamEvent = await prisma.streamEvent.findFirst({ where: { type: 'withdraw' } });
    expect(streamEvent).not.toBeNull();
    expect(streamEvent?.streamId).toBe(2n);
    expect(streamEvent?.ledger).toBe(100);
    expect(streamEvent?.payload).toMatchObject({ accrued: '500' });
  });

  it('applies a cancel event: settles accrued, zeroes balance/rate, marks cancelled', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('G') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('H'), name: 'NGO H' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 3n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('I'),
        rate: '10',
        balance: '1000',
        withdrawn: '200',
      },
    });

    const event = makeEvent(
      [symbolScVal('cancel'), u64ScVal(3n)],
      xdr.ScVal.scvVec([i128ScVal(300n), i128ScVal(700n)]),
    );
    await handleDonationVaultEvent(event);

    const stream = await prisma.stream.findUnique({ where: { onChainId: 3n } });
    expect(stream?.balance).toBe('0');
    expect(stream?.rate).toBe('0');
    expect(stream?.withdrawn).toBe('500'); // 200 already withdrawn + 300 settled on cancel
    expect(stream?.status).toBe('CANCELLED');

    // A StreamEvent row must be written atomically with the stream update.
    const streamEvent = await prisma.streamEvent.findFirst({ where: { type: 'cancel' } });
    expect(streamEvent).not.toBeNull();
    expect(streamEvent?.streamId).toBe(3n);
    expect(streamEvent?.ledger).toBe(100);
    expect(streamEvent?.payload).toMatchObject({ accrued: '300', refund: '700' });
  });

  it('ignores topup/ratemod events rather than corrupting balance (documented gap)', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('J') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('K'), name: 'NGO K' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 4n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('L'),
        rate: '10',
        balance: '1000',
        withdrawn: '0',
      },
    });

    await handleDonationVaultEvent(makeEvent([symbolScVal('topup'), u64ScVal(4n)], i128ScVal(500n)));

    const stream = await prisma.stream.findUnique({ where: { onChainId: 4n } });
    expect(stream?.balance).toBe('1000'); // unchanged — see the handler's comment

    // topup is intentionally unhandled — no StreamEvent row should be written.
    const streamEvent = await prisma.streamEvent.findFirst({ where: { type: 'topup' } });
    expect(streamEvent).toBeNull();
  });
});
