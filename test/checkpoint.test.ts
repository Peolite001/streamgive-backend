import { afterEach, describe, expect, it } from 'vitest';

import { getCheckpoint, saveCheckpoint } from '../src/indexer/checkpoint.js';
import { prisma } from '../src/db.js';
import { resetDb } from './helpers/db.js';

afterEach(async () => {
  await resetDb();
});

describe('checkpoint persistence', () => {
  it('creates then updates the single main checkpoint row', async () => {
    await saveCheckpoint(100);
    await saveCheckpoint(125);
    expect(await prisma.indexerCheckpoint.count()).toBe(1);
    expect(await getCheckpoint()).toBe(125);
  });

  it('returns the stored ledger and undefined when unset', async () => {
    expect(await getCheckpoint()).toBeUndefined();
    await saveCheckpoint(321);
    expect(await getCheckpoint()).toBe(321);
  });
});
