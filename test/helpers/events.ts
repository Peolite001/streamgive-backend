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
 *
 * `id` and `ledger` are only worth overriding for tests that drive
 * `pollOnce()` itself, where the checkpoint and the dead-letter row are
 * keyed on them; handler tests can ignore both.
 */
export function makeEvent(
  topic: xdr.ScVal[],
  value: xdr.ScVal,
  options?: { ledgerClosedAt?: string; id?: string; ledger?: number; txHash?: string },
): ContractEvent {
  const ledger = options?.ledger ?? 100;

  return {
    id: options?.id ?? `${String(ledger).padStart(10, '0')}-0000000000`,
    type: 'contract',
    ledger,
    ledgerClosedAt: options?.ledgerClosedAt ?? new Date().toISOString(),
    contractId: 'CTESTCONTRACTID',
    txHash: options?.txHash ?? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    topic,
    value,
    inSuccessfulContractCall: true,
  } as unknown as ContractEvent;
}
