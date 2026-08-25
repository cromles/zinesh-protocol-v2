import {
  makeActorId,
  makeAmount,
  makeCellId,
  makeCommandId,
  makeEventId,
  makeTimestamp,
} from '../core/types';
import type { FundingReceipt } from '../funding/types';
import { InMemoryFundingReceiptStore } from './in-memory-funding-receipt-store';

let sequence = 0;
function receipt(overrides: Partial<FundingReceipt> = {}): FundingReceipt {
  const id = ++sequence;
  return {
    intentId: `intent-${id}`,
    receiptId: `receipt-${id}`,
    provider: 'provider-a',
    providerTransactionId: `transaction-${id}`,
    cellId: makeCellId(`cell-${id}`),
    commandId: makeCommandId(`command-${id}`),
    fundingEventId: makeEventId(`funded-event-${id}`),
    gatewayPrincipalId: 'gateway-a',
    payer: makeActorId('payer-a'),
    payee: makeActorId('payee-a'),
    amount: makeAmount(1234567890123456789012345678901n),
    currency: 'TRY',
    destinationId: 'custody-a',
    confirmedAt: makeTimestamp(1_000_000),
    finality: 'FUNDS_HELD',
    evidenceDigest: 'a'.repeat(64),
    verifiedAt: makeTimestamp(1_000_100),
    createdAt: makeTimestamp(1_000_200),
    ...overrides,
  };
}

describe('provider-neutral funding receipt store contract', () => {
  test('new receipt is claimed and an identical financial identity is a duplicate', async () => {
    const store = new InMemoryFundingReceiptStore();
    const candidate = receipt();
    await expect(store.claim(candidate)).resolves.toEqual({ kind: 'CLAIMED' });
    const duplicate = await store.claim({
      ...candidate,
      receiptId: 'retry-receipt-id',
      verifiedAt: makeTimestamp(1_000_300),
      createdAt: makeTimestamp(1_000_400),
    });
    expect(duplicate.kind).toBe('DUPLICATE');
    if (duplicate.kind === 'DUPLICATE') {
      expect(duplicate.receipt).toEqual(candidate);
      expect(duplicate.receipt.amount).toBe(1234567890123456789012345678901n);
      expect(duplicate.receipt.evidenceDigest).toBe('a'.repeat(64));
      expect(Object.isFrozen(duplicate.receipt)).toBe(true);
    }
  });

  test.each([
    ['different cell', (base: FundingReceipt) => ({ ...base, cellId: makeCellId('other-cell') })],
    ['different amount', (base: FundingReceipt) => ({ ...base, amount: makeAmount(base.amount + 1n) })],
    ['different payer', (base: FundingReceipt) => ({ ...base, payer: makeActorId('other-payer') })],
    ['different payee', (base: FundingReceipt) => ({ ...base, payee: makeActorId('other-payee') })],
    ['different destination', (base: FundingReceipt) => ({ ...base, destinationId: 'other-custody' })],
    ['different evidence digest', (base: FundingReceipt) => ({ ...base, evidenceDigest: 'b'.repeat(64) })],
  ])('same provider transaction with %s is a security conflict', async (_name, mutate) => {
    const store = new InMemoryFundingReceiptStore();
    const original = receipt();
    expect((await store.claim(original)).kind).toBe('CLAIMED');
    const result = await store.claim(mutate(original));
    expect(result).toEqual({ kind: 'CONFLICT', conflict: 'PROVIDER_TRANSACTION' });
  });

  test('same cell with a second provider transaction is rejected', async () => {
    const store = new InMemoryFundingReceiptStore();
    const original = receipt();
    expect((await store.claim(original)).kind).toBe('CLAIMED');
    const result = await store.claim(receipt({ cellId: original.cellId }));
    expect(result).toEqual({ kind: 'CONFLICT', conflict: 'CELL' });
  });

  test('same command with a second receipt is rejected', async () => {
    const store = new InMemoryFundingReceiptStore();
    const original = receipt();
    expect((await store.claim(original)).kind).toBe('CLAIMED');
    const result = await store.claim(receipt({ commandId: original.commandId }));
    expect(result).toEqual({ kind: 'CONFLICT', conflict: 'COMMAND' });
  });

  test('same funding event with a second receipt is rejected', async () => {
    const store = new InMemoryFundingReceiptStore();
    const original = receipt();
    expect((await store.claim(original)).kind).toBe('CLAIMED');
    const result = await store.claim(receipt({ fundingEventId: original.fundingEventId }));
    expect(result).toEqual({ kind: 'CONFLICT', conflict: 'EVENT' });
  });

  test('same immutable intent cannot fund twice', async () => {
    const store = new InMemoryFundingReceiptStore();
    const original = receipt();
    expect((await store.claim(original)).kind).toBe('CLAIMED');
    const result = await store.claim(receipt({ intentId: original.intentId }));
    expect(result).toEqual({ kind: 'CONFLICT', conflict: 'INTENT' });
  });

  test('receipt identifier cannot be rebound', async () => {
    const store = new InMemoryFundingReceiptStore();
    const original = receipt();
    expect((await store.claim(original)).kind).toBe('CLAIMED');
    const result = await store.claim(receipt({ receiptId: original.receiptId }));
    expect(result).toEqual({ kind: 'CONFLICT', conflict: 'RECEIPT' });
  });
});
