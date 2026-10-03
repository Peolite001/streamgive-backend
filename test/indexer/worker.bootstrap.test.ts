import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks are hoisted and registered before any import resolution. The worker
// module reads process.env at module-evaluation time, so we re-import it
// fresh per test (via freshWorker) to pick up env var changes and reset the
// module-level `lastProcessedLedger` cache.
vi.mock('../../src/indexer/checkpoint.js', () => ({
  getCheckpoint: vi.fn(),
  saveCheckpoint: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/stellar/rpc.js', () => ({
  getLatestLedgerSequence: vi.fn(),
  rpcServer: { getEvents: vi.fn().mockResolvedValue({ events: [] }) },
}));
vi.mock('../../src/indexer/contracts.js', () => ({
  WATCHED_CONTRACT_IDS: ['CONTRACT_A'],
}));
// None of these cases drives a handler failure, so the dead-letter path is
// never reached. Mocked out anyway so re-importing the worker per case
// doesn't pull in src/db.js and open a fresh connection pool each time.
vi.mock('../../src/indexer/deadLetter.js', () => ({
  recordDeadLetter: vi.fn().mockResolvedValue(undefined),
}));

const checkpoint = await import('../../src/indexer/checkpoint.js');
const rpc = await import('../../src/stellar/rpc.js');
const deadLetter = await import('../../src/indexer/deadLetter.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkpoint.saveCheckpoint).mockResolvedValue(undefined);
  process.env.INDEXER_POLL_INTERVAL_MS = '20';
});

afterEach(() => {
  delete process.env.INDEXER_START_LEDGER;
  delete process.env.INDEXER_POLL_INTERVAL_MS;
});

// Returns a fresh worker module so the module-level `lastProcessedLedger`
// state and top-level env var constants are re-read on each test.
async function freshWorker() {
  vi.resetModules();
  vi.doMock('../../src/indexer/checkpoint.js', () => ({
    getCheckpoint: checkpoint.getCheckpoint,
    saveCheckpoint: checkpoint.saveCheckpoint,
  }));
  vi.doMock('../../src/stellar/rpc.js', () => ({
    getLatestLedgerSequence: rpc.getLatestLedgerSequence,
    rpcServer: rpc.rpcServer,
  }));
  vi.doMock('../../src/indexer/contracts.js', () => ({
    WATCHED_CONTRACT_IDS: ['CONTRACT_A'],
  }));
  vi.doMock('../../src/indexer/deadLetter.js', () => ({
    recordDeadLetter: deadLetter.recordDeadLetter,
  }));
  return import('../../src/indexer/worker.js');
}

type EventHandler = (event: unknown) => Promise<void>;

/**
 * Runs the indexer worker for a single poll tick by stopping it as soon as
 * an initial checkpoint is saved or after a short safety timeout.
 */
function runWorkerUntilFirstSave(
  startIndexer: (h: EventHandler) => () => Promise<void>,
  handleEvent: EventHandler = async () => {},
): Promise<void> {
  return new Promise<void>((resolve) => {
    let stop: (() => Promise<void>) | null = null;
    let finished = false;

    const finish = async () => {
      if (finished) return;
      finished = true;
      if (stop) {
        await stop();
      }
      resolve();
    };

    vi.mocked(checkpoint.saveCheckpoint).mockImplementation(async () => {
      setTimeout(() => {
        void finish();
      }, 0);
    });

    stop = startIndexer(handleEvent);
    setTimeout(() => {
      void finish();
    }, 150);
  });
}

function runWorkerBriefly(
  startIndexer: (h: EventHandler) => () => Promise<void>,
  handleEvent: EventHandler = async () => {},
): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = startIndexer(handleEvent);
    setTimeout(async () => {
      await stop();
      resolve();
    }, 100);
  });
}

describe('worker bootstrap (no existing checkpoint)', () => {
  it('saves INDEXER_START_LEDGER as the initial checkpoint when set', async () => {
    process.env.INDEXER_START_LEDGER = '1000';
    vi.mocked(checkpoint.getCheckpoint).mockResolvedValue(undefined);
    // latestLedger <= START_LEDGER so subsequent polls hit the "nothing new"
    // guard and return without calling saveCheckpoint again.
    vi.mocked(rpc.getLatestLedgerSequence).mockResolvedValue(1000);

    const { startIndexer } = await freshWorker();
    await runWorkerUntilFirstSave(startIndexer);

    expect(checkpoint.saveCheckpoint).toHaveBeenCalledWith(1000);
    // Must not fall back to the RPC latest ledger as the starting point.
    expect(checkpoint.saveCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('falls back to the latest ledger and processes no historical events when INDEXER_START_LEDGER is not set', async () => {
    vi.mocked(checkpoint.getCheckpoint).mockResolvedValue(undefined);
    vi.mocked(rpc.getLatestLedgerSequence).mockResolvedValue(5000);
    const handleEvent = vi.fn().mockResolvedValue(undefined);

    const { startIndexer } = await freshWorker();
    await runWorkerUntilFirstSave(startIndexer, handleEvent);

    expect(checkpoint.getCheckpoint).toHaveBeenCalled();
    expect(rpc.getLatestLedgerSequence).toHaveBeenCalled();
    expect(checkpoint.saveCheckpoint).toHaveBeenCalledWith(5000);
    expect(rpc.rpcServer.getEvents).not.toHaveBeenCalled();
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it('ignores INDEXER_START_LEDGER when a checkpoint already exists', async () => {
    process.env.INDEXER_START_LEDGER = '1000';
    vi.mocked(checkpoint.getCheckpoint).mockResolvedValue(8000);
    vi.mocked(rpc.getLatestLedgerSequence).mockResolvedValue(9999);

    const { startIndexer } = await freshWorker();
    await runWorkerBriefly(startIndexer);

    // Resumed from existing checkpoint — the env var must be ignored
    expect(checkpoint.saveCheckpoint).not.toHaveBeenCalledWith(1000);
  });

  it('advances the checkpoint when the latest ledger has no events', async () => {
    vi.mocked(checkpoint.getCheckpoint).mockResolvedValue(100);
    vi.mocked(rpc.getLatestLedgerSequence).mockResolvedValue(125);
    vi.mocked(rpc.rpcServer.getEvents).mockResolvedValue({ events: [] });

    const { startIndexer } = await freshWorker();
    await runWorkerBriefly(startIndexer);

    expect(checkpoint.saveCheckpoint).toHaveBeenCalledWith(125);
  });
});
