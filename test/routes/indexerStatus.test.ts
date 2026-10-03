import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

describe('GET /indexer/status (#59)', () => {
  it('returns configured: false when no contract IDs are set', async () => {
    const originalEnv = process.env.CONTRACT_IDS;
    delete process.env.CONTRACT_IDS;
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/indexer/status',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: false,
      checkpointLedger: null,
      updatedAt: null,
      latestLedger: null,
      ledgerLag: null,
    });

    if (originalEnv !== undefined) {
      process.env.CONTRACT_IDS = originalEnv;
    }
    await app.close();
  });

  it('returns checkpoint, latest ledger, and lag when configured', async () => {
    const originalEnv = process.env.CONTRACT_IDS;
    process.env.CONTRACT_IDS = 'C_TESTCONTRACT123';
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/indexer/status',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().configured).toBe(true);
    expect(response.json()).toHaveProperty('checkpointLedger');
    expect(response.json()).toHaveProperty('latestLedger');
    expect(response.json()).toHaveProperty('ledgerLag');

    if (originalEnv !== undefined) {
      process.env.CONTRACT_IDS = originalEnv;
    } else {
      delete process.env.CONTRACT_IDS;
    }
    await app.close();
  });
});
