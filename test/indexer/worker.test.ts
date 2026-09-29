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

const checkpoint = await import('../../src/indexer/checkpoint.js');
const rpc = await import('../../src/stellar/rpc.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkpoint.saveCheckpoint).mockResolvedValue(undefined);
  process.env.INDEXER_POLL_INTERVAL_MS = '50';
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
    rpcServer: { getEvents: vi.fn().mockResolvedValue({ events: [] }) },
  }));
  vi.doMock('../../src/indexer/contracts.js', () => ({
    WATCHED_CONTRACT_IDS: ['CONTRACT_A'],
  }));
  return import('../../src/indexer/worker.js');
}

function runWorkerBriefly(startIndexer: (h: () => Promise<void>) => () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = startIndexer(async () => {});
    // 200ms gives ~4 poll ticks at 50ms interval before we stop.
    setTimeout(() => { stop(); resolve(); }, 200);
  });
}

describe('worker bootstrap (no existing checkpoint)', () => {
  it('saves INDEXER_START_LEDGER as the initial checkpoint when set', async () => {
    process.env.INDEXER_START_LEDGER = '1000';
    vi.mocked(checkpoint.getCheckpoint).mockResolvedValue(undefined);
    vi.mocked(rpc.getLatestLedgerSequence).mockResolvedValue(9999);

    const { startIndexer } = await freshWorker();
    await runWorkerBriefly(startIndexer);

    // The first checkpoint written must come from INDEXER_START_LEDGER, not
    // from the chain head — later polls do consult the latest ledger, so we
    // assert on the *first* checkpoint rather than on total call counts.
    expect(checkpoint.saveCheckpoint).toHaveBeenNthCalledWith(1, 1000);
  });

  it('falls back to the latest ledger when INDEXER_START_LEDGER is not set', async () => {
    vi.mocked(checkpoint.getCheckpoint).mockResolvedValue(undefined);
    vi.mocked(rpc.getLatestLedgerSequence).mockResolvedValue(5000);

    const { startIndexer } = await freshWorker();
    await runWorkerBriefly(startIndexer);

    expect(rpc.getLatestLedgerSequence).toHaveBeenCalled();
    expect(checkpoint.saveCheckpoint).toHaveBeenCalledWith(5000);
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
});
