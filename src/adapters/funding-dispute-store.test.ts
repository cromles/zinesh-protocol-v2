import { makeAmount, makeCellId, makeTimestamp } from '../core/types';
import type { FundingDisputeObservation } from '../funding/types';
import { InMemoryFundingDisputeStore } from './in-memory-funding-dispute-store';
import { fundingDisputeAdvisoryLockKey } from './postgres-funding-dispute-store';

function observation(overrides: Partial<FundingDisputeObservation> = {}): FundingDisputeObservation {
  return {
    observationId: 'observation-1', provider: 'provider-a', providerDisputeId: 'dispute-a',
    providerTransactionId: 'transaction-a', observationVersion: 1n, receiptId: 'receipt-a',
    cellId: makeCellId('cell-a'), kind: 'CHARGEBACK', status: 'OPEN', outcome: 'PENDING', amount: makeAmount(4200n),
    currency: 'TRY', evidenceDigest: 'a'.repeat(64), observedAt: makeTimestamp(1_000),
    recordedAt: makeTimestamp(1_100), ...overrides,
  };
}

describe('provider funding dispute observation store contract', () => {
  test('derives a PostgreSQL-safe deterministic lock key without collapsing distinct identities', () => {
    const key = fundingDisputeAdvisoryLockKey('provider-a', 'dispute-a');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('\u0000');
    expect(fundingDisputeAdvisoryLockKey('provider-a', 'dispute-a')).toBe(key);
    expect(fundingDisputeAdvisoryLockKey('provider-a', 'dispute-b')).not.toBe(key);
    expect(fundingDisputeAdvisoryLockKey('ab', 'c'))
      .not.toBe(fundingDisputeAdvisoryLockKey('a', 'bc'));
  });

  test('is append-only and treats an identical provider observation as an idempotent duplicate', async () => {
    const store = new InMemoryFundingDisputeStore();
    const first = observation();
    await expect(store.record(first)).resolves.toEqual({ kind: 'RECORDED' });
    await expect(store.record({ ...first, recordedAt: makeTimestamp(1_200) })).resolves.toMatchObject({
      kind: 'DUPLICATE', observation: first,
    });
    expect(await store.hasBlockingDispute(first.cellId)).toBe(true);
  });

  test('rejects identity, version and evidence-digest rebinding', async () => {
    const store = new InMemoryFundingDisputeStore();
    const first = observation();
    await store.record(first);
    await expect(store.record({ ...first, status: 'RESOLVED', outcome: 'FUNDS_RETAINED' }))
      .resolves.toEqual({ kind: 'CONFLICT' });
    await expect(store.record(observation({ observationId: 'observation-2',
      status: 'RESOLVED', outcome: 'FUNDS_RETAINED' })))
      .resolves.toEqual({ kind: 'CONFLICT' });
    await expect(store.record(observation({ observationId: 'observation-3', observationVersion: 2n })))
      .resolves.toEqual({ kind: 'CONFLICT' });
    await expect(store.record(observation({ observationId: 'observation-4', observationVersion: 2n,
      receiptId: 'other-receipt', cellId: makeCellId('other-cell'), evidenceDigest: 'b'.repeat(64) })))
      .resolves.toEqual({ kind: 'CONFLICT' });
  });

  test('uses the latest provider version and keeps a funds-lost outcome financially blocking', async () => {
    const store = new InMemoryFundingDisputeStore();
    await store.record(observation());
    await store.record(observation({ observationId: 'observation-2', observationVersion: 2n,
      status: 'RESOLVED', outcome: 'FUNDS_RETAINED', evidenceDigest: 'b'.repeat(64) }));
    expect(await store.hasBlockingDispute(makeCellId('cell-a'))).toBe(false);
    await store.record(observation({ observationId: 'observation-3', observationVersion: 3n,
      status: 'CLOSED', outcome: 'FUNDS_LOST', evidenceDigest: 'c'.repeat(64) }));
    expect(await store.hasBlockingDispute(makeCellId('cell-a'))).toBe(true);
  });

  test('different provider disputes on one cell are evaluated independently', async () => {
    const store = new InMemoryFundingDisputeStore();
    await store.record(observation({ status: 'CLOSED', outcome: 'FUNDS_RETAINED' }));
    await store.record(observation({ observationId: 'observation-b', providerDisputeId: 'dispute-b',
      status: 'UNDER_REVIEW', evidenceDigest: 'b'.repeat(64) }));
    expect(await store.hasBlockingDispute(makeCellId('cell-a'))).toBe(true);
  });

  test('rejects lifecycle and financial outcome combinations that are semantically inconsistent', async () => {
    const store = new InMemoryFundingDisputeStore();
    await expect(store.record(observation({ status: 'OPEN', outcome: 'FUNDS_RETAINED' })))
      .resolves.toEqual({ kind: 'CONFLICT' });
    await expect(store.record(observation({ status: 'RESOLVED', outcome: 'PENDING' })))
      .resolves.toEqual({ kind: 'CONFLICT' });
  });
});
