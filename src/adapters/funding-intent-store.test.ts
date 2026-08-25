import { makeActorId, makeAmount, makeCellId, makeTimestamp } from '../core/types';
import type { FundingIntent } from '../funding/types';
import { createFundingIntent, hasValidFundingIntentBinding } from '../funding/funding-intent';
import { InMemoryFundingIntentStore } from './in-memory-funding-intent-store';

function intent(overrides: Partial<FundingIntent> = {}): FundingIntent {
  const { bindingDigest, ...draftOverrides } = overrides;
  const candidate = createFundingIntent({
    intentId: 'intent-1', provider: 'provider-a', cellId: makeCellId('cell-intent-1'),
    payer: makeActorId('payer-intent'), payee: makeActorId('payee-intent'),
    amount: makeAmount(4200n), currency: 'TRY', destinationId: 'custody-payee-intent',
    createdAt: makeTimestamp(1_000), expiresAt: makeTimestamp(2_000), ...draftOverrides,
  });
  return bindingDigest === undefined ? candidate : { ...candidate, bindingDigest };
}

describe('provider-neutral funding intent store contract', () => {
  test('creates an immutable exact binding and replays the identical intent', async () => {
    const store = new InMemoryFundingIntentStore();
    const candidate = intent();
    await expect(store.create(candidate)).resolves.toEqual({ kind: 'CREATED' });
    const duplicate = await store.create({ ...candidate });
    expect(duplicate).toEqual({ kind: 'DUPLICATE', intent: candidate });
    await expect(store.get(candidate.intentId)).resolves.toEqual(candidate);
    expect(Object.isFrozen(await store.get(candidate.intentId))).toBe(true);
    expect(hasValidFundingIntentBinding(candidate)).toBe(true);
  });

  test.each([
    ['provider', { provider: 'provider-b' }],
    ['cell', { cellId: makeCellId('cell-intent-2') }],
    ['payer', { payer: makeActorId('other-payer') }],
    ['payee', { payee: makeActorId('other-payee') }],
    ['amount', { amount: makeAmount(4201n) }],
    ['currency', { currency: 'EUR' as never }],
    ['destination', { destinationId: 'other-custody' }],
    ['expiry', { expiresAt: makeTimestamp(2_001) }],
  ])('rejects rebinding an intent by %s', async (_field, change) => {
    const store = new InMemoryFundingIntentStore();
    const original = intent();
    await store.create(original);
    await expect(store.create(intent(change))).resolves.toEqual({ kind: 'CONFLICT' });
    await expect(store.get(original.intentId)).resolves.toEqual(original);
  });

  test('rejects an intent whose canonical binding digest was forged', async () => {
    const store = new InMemoryFundingIntentStore();
    await expect(store.create(intent({ bindingDigest: 'b'.repeat(64) })))
      .resolves.toEqual({ kind: 'INVALID' });
    await expect(store.get('intent-1')).resolves.toBeNull();
  });

  test('factory rejects empty identities and an inverted confirmation window', () => {
    const original = intent();
    const { bindingDigest: _bindingDigest, ...draft } = original;
    expect(() => createFundingIntent({ ...draft, intentId: '' })).toThrow();
    expect(() => createFundingIntent({ ...draft, createdAt: makeTimestamp(2_001),
      expiresAt: makeTimestamp(2_000) })).toThrow();
  });
});
