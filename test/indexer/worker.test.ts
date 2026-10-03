import { xdr } from '@stellar/stellar-sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { getCheckpoint, saveCheckpoint } from '../../src/indexer/checkpoint.js';
import type { ContractEvent } from '../../src/indexer/worker.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import { addressScVal, i128ScVal, makeEvent, symbolScVal, u64ScVal } from '../helpers/events.js';

const mocks = vi.hoisted(() => {
  const contractId = 'CTESTCONTRACTID';

  // contracts.ts reads this at module load, and `pollOnce` no-ops when no
  // contract id is configured — vi.hoisted() runs before this file's imports,
  // which is the only point early enough to set it. The value matches the
  // contract id makeEvent() stamps on its fixtures, so dispatchEvent routes
  // them to the donation-vault handler.
  process.env.DONATION_VAULT_CONTRACT_ID = contractId;

  return {
    contractId,
    getEvents: vi.fn(),
    getLatestLedgerSequence: vi.fn(),
    getCheckpoint: vi.fn(),
    saveCheckpoint: vi.fn(),
    // Memoised here, in a closure the module registry reset below does not
    // touch, so every re-import shares one PrismaClient (and one connection
    // pool) instead of opening a fresh one per case.
    db: undefined as { prisma: typeof prisma } | undefined,
  };
});

vi.mock('../../src/db.js', async () => {
  mocks.db ??= { ...(await vi.importActual<{ prisma: typeof prisma }>('../../src/db.js')) };
  return mocks.db;
});

vi.mock('../../src/stellar/rpc.js', () => ({
  rpcServer: { getEvents: mocks.getEvents },
  getLatestLedgerSequence: mocks.getLatestLedgerSequence,
}));

vi.mock('../../src/indexer/checkpoint.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/indexer/checkpoint.js')>(
      '../../src/indexer/checkpoint.js',
    );

  // Default both to the real implementation, so the pollOnce cases above keep
  // writing the actual row and reading it back out of the database. Only the
  // backoff cases override these, and only because they care about the delay
  // schedule rather than the stored value.
  mocks.getCheckpoint.mockImplementation(actual.getCheckpoint);
  mocks.saveCheckpoint.mockImplementation(actual.saveCheckpoint);

  return {
    ...actual,
    getCheckpoint: mocks.getCheckpoint,
    saveCheckpoint: mocks.saveCheckpoint,
  };
});

/**
 * `pollOnce` caches its checkpoint in a module-level variable for the life of
 * the process. Re-importing the worker gives each case an indexer that reads
 * the checkpoint back from the database, so the cases stay independent of
 * each other and of the order they run in.
 */
async function freshIndexer() {
  vi.resetModules();
  const [{ pollOnce, backoffDelayMs, startIndexer }, { dispatchEvent }] = await Promise.all([
    import('../../src/indexer/worker.js'),
    import('../../src/indexer/dispatch.js'),
  ]);
  return { pollOnce, dispatchEvent, backoffDelayMs, startIndexer };
}

/**
 * A `created` event whose payload is a bare i128 instead of the
 * `[donor, ngo, token, deposit, rate]` vector the handler destructures. This
 * is exactly the shape mismatch the handler's unchecked `as [...]` cast
 * cannot survive: destructuring a bigint throws, and without per-event
 * isolation that throw escapes `pollOnce` before it can save a checkpoint.
 */
function malformedCreatedEvent(ledger: number) {
  return makeEvent([symbolScVal('created'), u64ScVal(99n)], i128ScVal(1000n), {
    id: `poison-${ledger}`,
    ledger,
  });
}

function wellFormedCreatedEvent(ledger: number, onChainId: bigint) {
  return makeEvent(
    [symbolScVal('created'), u64ScVal(onChainId)],
    xdr.ScVal.scvVec([
      addressScVal(fakeAddress('A')),
      addressScVal(fakeAddress('B')),
      addressScVal(fakeAddress('C')),
      i128ScVal(1000n),
      i128ScVal(10n),
    ]),
    { id: `good-${ledger}`, ledger },
  );
}

describe('pollOnce', () => {
  beforeEach(() => {
    mocks.getEvents.mockReset();
    mocks.getLatestLedgerSequence.mockReset();
    // The dead-letter path logs through console.error and the email
    // notification stub through console.log; neither is under test here.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
  });

  afterAll(() => {
    delete process.env.DONATION_VAULT_CONTRACT_ID;
  });

  it('advances past a malformed event instead of retrying it forever', async () => {
    const { pollOnce, dispatchEvent } = await freshIndexer();

    await saveCheckpoint(100);
    mocks.getLatestLedgerSequence.mockResolvedValue(110);

    // Both events arrive in one batch with the undecodable one first, so a
    // handler failure that propagated would take the good event down with it.
    mocks.getEvents.mockResolvedValueOnce({
      events: [malformedCreatedEvent(101), wellFormedCreatedEvent(102, 7n)],
      latestLedger: 110,
    });

    await pollOnce(dispatchEvent);

    // The checkpoint moved past the poison event and on through the good one.
    expect(await getCheckpoint()).toBe(102);

    // The event behind it was indexed rather than blocked.
    const stream = await prisma.stream.findUnique({ where: { onChainId: 7n } });
    expect(stream?.balance).toBe('1000');

    // The failure is recorded rather than silently dropped.
    const deadLetter = await prisma.indexerDeadLetter.findUnique({
      where: { eventId: 'poison-101' },
    });
    expect(deadLetter?.ledger).toBe(101);
    expect(deadLetter?.contractId).toBe(mocks.contractId);
    expect(deadLetter?.error).not.toBe('');

    // And the next poll starts after it, so it is never seen again — the
    // wedge this whole change exists to prevent.
    mocks.getEvents.mockResolvedValueOnce({ events: [], latestLedger: 110 });
    await pollOnce(dispatchEvent);

    expect(mocks.getEvents).toHaveBeenLastCalledWith(expect.objectContaining({ startLedger: 103 }));
    expect(await getCheckpoint()).toBe(110);
  });

  it('records one dead letter per failing event and keeps going', async () => {
    const { pollOnce, dispatchEvent } = await freshIndexer();

    await saveCheckpoint(200);
    mocks.getLatestLedgerSequence.mockResolvedValue(220);
    mocks.getEvents.mockResolvedValueOnce({
      events: [
        malformedCreatedEvent(201),
        malformedCreatedEvent(202),
        wellFormedCreatedEvent(203, 8n),
      ],
      latestLedger: 220,
    });

    await pollOnce(dispatchEvent);

    expect(await getCheckpoint()).toBe(203);
    expect(await prisma.indexerDeadLetter.count()).toBe(2);
    expect(await prisma.stream.findUnique({ where: { onChainId: 8n } })).not.toBeNull();
  });

  it('writes no dead letters when every event handles cleanly', async () => {
    const { pollOnce, dispatchEvent } = await freshIndexer();

    await saveCheckpoint(300);
    mocks.getLatestLedgerSequence.mockResolvedValue(320);
    mocks.getEvents.mockResolvedValueOnce({
      events: [wellFormedCreatedEvent(301, 9n)],
      latestLedger: 320,
    });

    await pollOnce(dispatchEvent);

    expect(await getCheckpoint()).toBe(301);
    expect(await prisma.indexerDeadLetter.count()).toBe(0);
    expect(await prisma.stream.findUnique({ where: { onChainId: 9n } })).not.toBeNull();
  });

  it('checkpoints the last event after handling a multi-event batch', async () => {
    const { pollOnce } = await freshIndexer();
    const handleEvent = vi.fn(async () => {});

    await saveCheckpoint(400);
    mocks.getLatestLedgerSequence.mockResolvedValue(420);
    mocks.getEvents.mockResolvedValueOnce({
      events: [
        wellFormedCreatedEvent(401, 11n),
        wellFormedCreatedEvent(402, 12n),
        wellFormedCreatedEvent(403, 13n),
      ],
      latestLedger: 420,
    });

    await pollOnce(handleEvent);

    expect(handleEvent).toHaveBeenCalledTimes(3);
    expect(await getCheckpoint()).toBe(403);
  });

  it('keeps the checkpoint at the last successful event if failure recording fails', async () => {
    const { pollOnce } = await freshIndexer();
    const handleEvent = vi.fn(async (event: ContractEvent) => {
      if (event.ledger === 502) throw new Error('handler failed');
    });

    await saveCheckpoint(500);
    mocks.getLatestLedgerSequence.mockResolvedValue(520);
    mocks.getEvents.mockResolvedValueOnce({
      events: [
        wellFormedCreatedEvent(501, 14n),
        wellFormedCreatedEvent(502, 15n),
        wellFormedCreatedEvent(503, 16n),
      ],
      latestLedger: 520,
    });
    vi.spyOn(prisma.indexerDeadLetter, 'upsert').mockRejectedValueOnce(
      new Error('dead-letter store unavailable'),
    );

    await expect(pollOnce(handleEvent)).rejects.toThrow('dead-letter store unavailable');

    expect(handleEvent).toHaveBeenCalledTimes(2);
    expect(await getCheckpoint()).toBe(501);
  });
});

describe('backoff on RPC failures (#115)', () => {
  beforeEach(() => {
    // The pollOnce block's afterAll deletes this, and these cases run after
    // it. contracts.ts reads it at module load, and freshIndexer() calls
    // vi.resetModules(), so it has to be back in place before that re-import
    // or WATCHED_CONTRACT_IDS comes back empty and pollOnce() no-ops without
    // ever reaching the RPC.
    process.env.DONATION_VAULT_CONTRACT_ID = mocks.contractId;
    // clearAllMocks() in the outer hook clears call history but leaves
    // implementations in place, so a mockRejectedValue from one test would
    // otherwise leak into the next one. Each test below sets its own.
    vi.mocked(mocks.getLatestLedgerSequence).mockReset();
    // These cases assert the delay schedule, not what lands in the database,
    // and the checkpoint write on a successful poll would otherwise need a live
    // Postgres. Stub both; the pollOnce cases above keep the real pair.
    mocks.getCheckpoint.mockResolvedValue(100);
    mocks.saveCheckpoint.mockResolvedValue(undefined);
    // Every test here drives the failure path, which logs on purpose.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('does not overlap polls when an RPC request takes longer than the interval', async () => {
    process.env.INDEXER_POLL_INTERVAL_MS = '10';
    mocks.getCheckpoint.mockResolvedValue(100);
    mocks.saveCheckpoint.mockResolvedValue(undefined);
    let latestLedger = 100;
    mocks.getLatestLedgerSequence.mockImplementation(async () => ++latestLedger);

    let activePolls = 0;
    let maxConcurrentPolls = 0;
    mocks.getEvents.mockImplementation(async () => {
      activePolls += 1;
      maxConcurrentPolls = Math.max(maxConcurrentPolls, activePolls);
      await new Promise((resolve) => setTimeout(resolve, 50));
      activePolls -= 1;
      return { events: [], latestLedger: 101 };
    });

    const { startIndexer } = await freshIndexer();
    vi.useFakeTimers();

    const stop = startIndexer(async () => {});
    await vi.advanceTimersByTimeAsync(175);
    await stop();

    expect(maxConcurrentPolls).toBe(1);
    expect(mocks.getEvents).toHaveBeenCalledTimes(3);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('grows the delay with each consecutive failure, up to a cap', async () => {
    process.env.INDEXER_POLL_INTERVAL_MS = '1000';

    const { backoffDelayMs } = await freshIndexer();

    expect(backoffDelayMs(0)).toBe(1000);
    // One failure is not an outage: retry once at the normal interval rather
    // than making a single blip look like one.
    expect(backoffDelayMs(1)).toBe(1000);
    // Then it doubles per failure.
    expect(backoffDelayMs(2)).toBe(2000);
    expect(backoffDelayMs(3)).toBe(4000);
    expect(backoffDelayMs(4)).toBe(8000);
    expect(backoffDelayMs(5)).toBe(16000);

    // Capped, so a long outage still re-checks the endpoint periodically
    // instead of drifting to a delay that looks like a hung indexer.
    expect(backoffDelayMs(30)).toBe(5 * 60_000);
    expect(backoffDelayMs(31)).toBe(backoffDelayMs(30));
    // And strictly below the uncapped value it replaces.
    expect(backoffDelayMs(30)).toBeLessThan(1000 * 2 ** 29);
  });

  it('waits longer before each retry while the RPC keeps failing', async () => {
    process.env.INDEXER_POLL_INTERVAL_MS = '1000';
    mocks.getCheckpoint.mockResolvedValue(100);
    vi.mocked(mocks.getLatestLedgerSequence).mockRejectedValue(new Error('RPC unreachable'));

    const { startIndexer } = await freshIndexer();
    vi.useFakeTimers();

    const stop = startIndexer(async () => {});

    // Poll 1 runs immediately, fails, and schedules its retry 1s out.
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getLatestLedgerSequence).toHaveBeenCalledTimes(1);

    // Still nothing at 999ms — the first retry really is a full interval away.
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.getLatestLedgerSequence).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.getLatestLedgerSequence).toHaveBeenCalledTimes(2);

    // Poll 2 failed too, so the next wait doubles to 2s. One more second is
    // not enough to trigger it.
    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.getLatestLedgerSequence).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.getLatestLedgerSequence).toHaveBeenCalledTimes(3);

    // And again to 4s: nothing at 3.9s, poll 4 at 4s.
    await vi.advanceTimersByTimeAsync(3900);
    expect(mocks.getLatestLedgerSequence).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.getLatestLedgerSequence).toHaveBeenCalledTimes(4);

    await stop();
  });

  it('resets the delay to the poll interval after a successful poll', async () => {
    process.env.INDEXER_POLL_INTERVAL_MS = '1000';
    mocks.getCheckpoint.mockResolvedValue(100);
    vi.mocked(mocks.getLatestLedgerSequence)
      .mockRejectedValueOnce(new Error('RPC unreachable'))
      .mockRejectedValueOnce(new Error('RPC unreachable'))
      .mockResolvedValue(500);
    // Only this case has a poll that succeeds, so this is the only one that
    // reaches the event fetch. pollOnce() destructures the result, so it has
    // to be a real shape — an empty list still counts as a scanned window, so
    // the poll completes and the counter resets rather than throwing.
    mocks.getEvents.mockResolvedValue({ events: [], latestLedger: 500 });

    const { startIndexer } = await freshIndexer();
    vi.useFakeTimers();

    const stop = startIndexer(async () => {});

    // Two failures, so the counter is at 2 and the next delay would be 4s...
    await vi.advanceTimersByTimeAsync(0); // poll 1 fails, retry in 1s
    await vi.advanceTimersByTimeAsync(1000); // poll 2 fails, retry in 2s
    expect(mocks.getLatestLedgerSequence).toHaveBeenCalledTimes(2);

    // ...but poll 3 gets a response, which clears the counter and drops the
    // next delay straight back to the poll interval.
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.getLatestLedgerSequence).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.getLatestLedgerSequence).toHaveBeenCalledTimes(4);

    await stop();
  });
});
