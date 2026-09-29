import { describe, expect, it } from 'vitest';

import { startIndexer } from '../src/indexer.js';

describe('Indexer Non-Overlapping Polls (#37)', () => {
  it('does not run two polls concurrently when a poll takes longer than the interval', async () => {
    let activePolls = 0;
    let maxConcurrent = 0;
    let pollCount = 0;

    const slowPoll = async () => {
      activePolls++;
      maxConcurrent = Math.max(maxConcurrent, activePolls);
      pollCount++;
      // Simulate slow RPC call longer than interval
      await new Promise((resolve) => setTimeout(resolve, 50));
      activePolls--;
    };

    // Start indexer with a 10ms interval
    const stop = startIndexer(slowPoll, 10);

    // Wait long enough for multiple ticks to attempt firing
    await new Promise((resolve) => setTimeout(resolve, 130));

    stop();

    expect(maxConcurrent).toBe(1);
    expect(pollCount).toBeGreaterThan(1);
  });
});