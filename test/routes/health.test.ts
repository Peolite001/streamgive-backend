import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import * as rpc from '../../src/stellar/rpc.js';

describe('GET /v1/health', () => {
  beforeEach(() => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{}]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 200 when both database and RPC are reachable', async () => {
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockResolvedValueOnce(1);

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', db: 'ok', rpc: 'ok' });

    await app.close();
  });

<<<<<<< HEAD
  it('responds with a structured 503 error when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Database connection failed'));
=======
  it('responds with 503 when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('connection refused'));
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockResolvedValueOnce(1);
>>>>>>> 4d64890 (fix: check Soroban RPC connectivity in the health check)

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(503);
<<<<<<< HEAD
    expect(response.json()).toEqual({ status: 'error', database: 'unreachable' });
=======
    expect(response.json()).toMatchObject({ status: 'error', db: 'error', rpc: 'ok' });

    await app.close();
  });

  it('responds with 503 when the RPC endpoint is unreachable', async () => {
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockRejectedValueOnce(new Error('RPC unreachable'));

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'error', db: 'ok', rpc: 'error' });
>>>>>>> 4d64890 (fix: check Soroban RPC connectivity in the health check)

    await app.close();
  });

  it('does not rate limit repeated health checks', async () => {
    const previousMax = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_MAX = '1';
    const app = buildServer();

    const responses = await Promise.all(
      Array.from({ length: 3 }, () => app.inject({ method: 'GET', url: '/v1/health' })),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);

    await app.close();
    if (previousMax === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = previousMax;
  });
});

describe('GET /health/ready', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 200 and status ok when DB and RPC are reachable and lag is within threshold', async () => {
    const rpcSpy = vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10050);
    const checkpointSpy = vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      lag: 50,
      latestLedger: 10050,
      checkpointLedger: 10000,
    });

    await app.close();
  });

  it('responds with 503 when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Database connection failed'));

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'service_unavailable' });

    await app.close();
  });

  it('responds with 503 when RPC is unreachable', async () => {
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockRejectedValue(new Error('RPC connection failed'));
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'service_unavailable' });

    await app.close();
  });

  it('responds with 503 when indexer has no checkpoint', async () => {
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10050);
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(undefined);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'indexer_not_started' });

    await app.close();
  });

  it('responds with 503 when indexer lag is above threshold', async () => {
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10150);
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'indexer_lagging', lag: 150, threshold: 100 });

    await app.close();
  });
});
