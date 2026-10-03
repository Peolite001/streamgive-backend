import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as checkpoint from './checkpoint.js';
import * as contracts from './contracts.js';
import * as rpc from '../stellar/rpc.js';
import { startIndexer } from './worker.js';

vi.mock('./checkpoint.js');
vi.mock('../stellar/rpc.js');

describe('startIndexer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(contracts, 'WATCHED_CONTRACT_IDS', 'get').mockReturnValue(['C_TEST']);
    vi.mocked(checkpoint.getCheckpoint).mockResolvedValue(100);
    vi.mocked(checkpoint.saveCheckpoint).mockResolvedValue();
    vi.mocked(rpc.getLatestLedgerSequence).mockResolvedValue(100);
    vi.mocked(rpc.rpcServer.getEvents).mockResolvedValue({ events: [], latestLedger: 100 } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stops polling after the stop function is called', async () => {
    const handler = vi.fn();
    const stop = startIndexer(handler);

    await vi.runAllTimersAsync();
    const stop$ = stop();
    await stop$;

    const callsBefore = vi.mocked(rpc.getLatestLedgerSequence).mock.calls.length;
    await vi.runAllTimersAsync();
    expect(vi.mocked(rpc.getLatestLedgerSequence).mock.calls.length).toBe(callsBefore);
  });
});
