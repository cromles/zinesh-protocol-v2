import { makeAmount, makeTimestamp } from '../core/types';
import type { ProviderEvent, ProviderNegativeObservation,
  ProviderTransactionCorrelation } from '../funding/provider-evidence';
import { providerIdentityHash } from '../funding/provider-identity';
import { InMemoryProviderFoundationStore } from './in-memory-provider-foundation-store';

const event: ProviderEvent = { eventIdentity:'a'.repeat(64),replayIdentity:'b'.repeat(64),
  provider:'provider',environment:'SANDBOX',providerPaymentId:'payment',providerTransactionId:'tx',
  intentId:'intent',eventType:'PAYMENT',payloadDigest:'c'.repeat(64),receivedAt:makeTimestamp(1) };
const correlation: ProviderTransactionCorrelation = { provider:'provider',environment:'SANDBOX',
  providerTransactionId:'tx',providerPaymentId:'payment',intentId:'intent',cellId:'cell',
  createdAt:makeTimestamp(1) };
const negative: ProviderNegativeObservation = { observationId:'d'.repeat(64),provider:'provider',
  environment:'SANDBOX',providerObservationId:'refund-1',providerTransactionId:'tx',intentId:'intent',
  kind:'REFUND',amountMinor:makeAmount(20n),currency:'TRY',payloadDigest:'e'.repeat(64),
  observedAt:makeTimestamp(2),recordedAt:makeTimestamp(3) };

describe('provider foundation security boundaries', () => {
  test('distinguishes first event, exact duplicate, conflicting duplicate and payload replay', async () => {
    const store=new InMemoryProviderFoundationStore();
    await expect(store.recordEvent(event)).resolves.toEqual({kind:'FIRST_SEEN'});
    await expect(store.recordEvent(event)).resolves.toMatchObject({kind:'DUPLICATE'});
    await expect(store.recordEvent({...event,eventIdentity:'f'.repeat(64),payloadDigest:'0'.repeat(64)}))
      .resolves.toEqual({kind:'REPLAY_PAYLOAD_CONFLICT'});
    await expect(store.recordEvent({...event,eventType:'OTHER'}))
      .resolves.toEqual({kind:'CONFLICTING_DUPLICATE'});
  });
  test('provider transaction and intent correlation cannot be rebound', async () => {
    const store=new InMemoryProviderFoundationStore();
    await expect(store.correlateTransaction(correlation)).resolves.toEqual({kind:'RECORDED'});
    await expect(store.correlateTransaction(correlation)).resolves.toMatchObject({kind:'DUPLICATE'});
    await expect(store.correlateTransaction({...correlation,intentId:'other'}))
      .resolves.toEqual({kind:'CONFLICT'});
    await expect(store.correlateTransaction({...correlation,providerTransactionId:'other'}))
      .resolves.toEqual({kind:'CONFLICT'});
  });
  test('negative observations are append-only and conflicting reuse is rejected', async () => {
    const store=new InMemoryProviderFoundationStore();
    await expect(store.appendNegativeObservation(negative)).resolves.toEqual({kind:'RECORDED'});
    await expect(store.appendNegativeObservation(negative)).resolves.toMatchObject({kind:'DUPLICATE'});
    await expect(store.appendNegativeObservation({...negative,intentId:'other'}))
      .resolves.toEqual({kind:'CONFLICT'});
  });
  test('same transaction ID remains isolated by provider account scope', async () => {
    const store=new InMemoryProviderFoundationStore();
    const a={...correlation,providerAccountScope:'account-A'};
    const b={...correlation,providerAccountScope:'account-B',intentId:'intent-B',cellId:'cell-B'};
    expect(await store.correlateTransaction(a)).toEqual({kind:'RECORDED'});
    expect(await store.correlateTransaction(b)).toEqual({kind:'RECORDED'});
    expect(await store.getCorrelation('provider','SANDBOX','tx','account-A')).toMatchObject({intentId:'intent'});
    expect(await store.getCorrelation('provider','SANDBOX','tx','account-B')).toMatchObject({intentId:'intent-B'});
    const negativeA={...negative,providerAccountScope:'account-A',cellId:'cell'};
    const negativeB={...negative,observationId:'f'.repeat(64),providerAccountScope:'account-B',
      providerObservationId:'refund-B',intentId:'intent-B',cellId:'cell-B'};
    expect(await store.appendNegativeObservation(negativeA)).toEqual({kind:'RECORDED'});
    expect(await store.appendNegativeObservation(negativeA)).toMatchObject({kind:'DUPLICATE'});
    expect(await store.appendNegativeObservation(negativeB)).toEqual({kind:'RECORDED'});
    expect(store.hasBlockingNegativeForCell('cell')).toBe(true);
    expect(store.hasBlockingNegativeForCell('cell-B')).toBe(true);
  });
  test('length-prefixed SHA-256 identity is deterministic, unambiguous and PostgreSQL-safe', () => {
    expect(providerIdentityHash('ab','c')).toBe(providerIdentityHash('ab','c'));
    expect(providerIdentityHash('ab','c')).not.toBe(providerIdentityHash('a','bc'));
    expect(providerIdentityHash('provider','dispute')).toMatch(/^[0-9a-f]{64}$/);
    expect(providerIdentityHash('provider','dispute')).not.toContain('\0');
  });
  test('negative observation retries ignore property order and absent optional fields', async () => {
    const store=new InMemoryProviderFoundationStore();
    await expect(store.appendNegativeObservation(negative)).resolves.toEqual({kind:'RECORDED'});
    const reordered = Object.fromEntries(Object.entries(negative).reverse()) as unknown as ProviderNegativeObservation;
    await expect(store.appendNegativeObservation({...reordered,receiptId:undefined,cellId:undefined}))
      .resolves.toEqual({kind:'DUPLICATE',observation:negative});
    await expect(store.appendNegativeObservation({...reordered,amountMinor:makeAmount(21n)}))
      .resolves.toEqual({kind:'CONFLICT'});
    await expect(store.appendNegativeObservation({...reordered,payloadDigest:'f'.repeat(64)}))
      .resolves.toEqual({kind:'CONFLICT'});
  });
});
