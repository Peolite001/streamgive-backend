import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import type { ContractEvent } from '../../src/indexer/worker.js';

export function symbolScVal(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: 'symbol' });
}

export function stringScVal(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: 'string' });
}

export function u64ScVal(value: bigint | number): xdr.ScVal {
  return nativeToScVal(value, { type: 'u64' });
}

export function i128ScVal(value: bigint | number): xdr.ScVal {
  return nativeToScVal(value, { type: 'i128' });
}

export function addressScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

/**
 * Builds just enough of a getEvents() response entry to exercise the
 * indexer handlers: they only ever read `.topic` and `.value`. `topic` and
 * `value` are built from real ScVal constructors (not plain JS objects),
 * so these tests catch actual encode/decode mismatches rather than just
 * confirming a mock behaves the way we assumed it would.
 */
export function makeEvent(
  topic: xdr.ScVal[],
  value: xdr.ScVal,
  options?: { ledgerClosedAt?: string; ledger?: number; txHash?: string },
): ContractEvent {
  return {
    id: '0000000001-0000000000',
    type: 'contract',
    ledger: options?.ledger ?? 100,
    ledgerClosedAt: options?.ledgerClosedAt ?? new Date().toISOString(),
    contractId: 'CTESTCONTRACTID',
    txHash: options?.txHash ?? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    topic,
    value,
    inSuccessfulContractCall: true,
  } as unknown as ContractEvent;
}
