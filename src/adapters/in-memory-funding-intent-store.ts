import type { FundingIntent } from '../funding/types';
import type { FundingIntentCreateResult, FundingIntentStore } from './funding-intent-store';
import { sameFundingIntent } from './funding-intent-store';
import { hasValidFundingIntentBinding } from '../funding/funding-intent';

export class InMemoryFundingIntentStore implements FundingIntentStore {
  private readonly intents = new Map<string, FundingIntent>();

  async create(intent: FundingIntent): Promise<FundingIntentCreateResult> {
    if (!hasValidFundingIntentBinding(intent)) return { kind: 'INVALID' };
    const existing = this.intents.get(intent.intentId);
    if (existing !== undefined) {
      return sameFundingIntent(existing, intent)
        ? { kind: 'DUPLICATE', intent: existing } : { kind: 'CONFLICT' };
    }
    this.intents.set(intent.intentId, Object.freeze({ ...intent }));
    return { kind: 'CREATED' };
  }

  async get(intentId: string): Promise<FundingIntent | null> {
    return this.intents.get(intentId) ?? null;
  }
}
