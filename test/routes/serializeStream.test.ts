import { describe, expect, it } from 'vitest';

import { serializeStream } from '../../src/routes/streams.js';

describe('serializeStream', () => {
  it('converts onChainId from BigInt to its string representation', () => {
    const result = serializeStream({
      onChainId: 9007199254740993n, // larger than Number.MAX_SAFE_INTEGER to prove no precision loss
      ngo: { name: 'Red Cross' },
    });

    expect(result.onChainId).toBe('9007199254740993');
    expect(typeof result.onChainId).toBe('string');
  });

  it('leaves all other fields intact', () => {
    const input = {
      id: 'abc-123',
      onChainId: 1n,
      donorId: 'donor-uuid',
      ngoId: 'ngo-uuid',
      tokenAddress: 'GABC',
      rate: '10',
      balance: '1000',
      withdrawn: '0',
      status: 'ACTIVE' as const,
      createdAt: new Date('2024-01-15T12:00:00.000Z'),
      updatedAt: new Date('2024-01-15T12:00:00.000Z'),
      ngo: { id: 'ngo-uuid', name: 'Doctors Without Borders', ownerAddress: 'GXYZ' },
    };

    const result = serializeStream(input);

    expect(result.id).toBe(input.id);
    expect(result.donorId).toBe(input.donorId);
    expect(result.ngoId).toBe(input.ngoId);
    expect(result.tokenAddress).toBe(input.tokenAddress);
    expect(result.rate).toBe(input.rate);
    expect(result.balance).toBe(input.balance);
    expect(result.withdrawn).toBe(input.withdrawn);
    expect(result.status).toBe(input.status);
    expect(result.createdAt).toBe(input.createdAt);
    expect(result.updatedAt).toBe(input.updatedAt);
  });

  it('passes ngo fields through and sets registered: true when name is non-empty', () => {
    const result = serializeStream({
      onChainId: 1n,
      ngo: { id: 'ngo-uuid', name: 'Red Cross', ownerAddress: 'GABC' },
    });

    expect(result.ngo.name).toBe('Red Cross');
    expect(result.ngo.registered).toBe(true);
    // other ngo fields are preserved
    expect((result.ngo as { id?: string }).id).toBe('ngo-uuid');
    expect((result.ngo as { ownerAddress?: string }).ownerAddress).toBe('GABC');
  });

  it('sets ngo.name to null and registered: false when name is an empty string (placeholder NGO)', () => {
    const result = serializeStream({
      onChainId: 2n,
      ngo: { name: '' },
    });

    expect(result.ngo.name).toBeNull();
    expect(result.ngo.registered).toBe(false);
  });
});
