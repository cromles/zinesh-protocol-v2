import { createHash } from 'crypto';
import type { FundingIntent } from './types';

export type FundingIntentDraft = Omit<FundingIntent, 'bindingDigest'>;

/** Creates the immutable digest over every field that authorizes a funding attempt. */
export function createFundingIntent(draft: FundingIntentDraft): FundingIntent {
  if (!hasValidFundingIntentShape(draft)) {
    throw new Error('Invalid funding intent binding');
  }
  return Object.freeze({ ...draft, bindingDigest: fundingIntentBindingDigest(draft) });
}

export function hasValidFundingIntentBinding(intent: FundingIntent): boolean {
  return hasValidFundingIntentShape(intent)
    && intent.bindingDigest === fundingIntentBindingDigest(intent);
}

export function fundingIntentBindingDigest(intent: FundingIntentDraft): string {
  const hash = createHash('sha256');
  for (const value of [
    intent.intentId, intent.provider, intent.cellId, intent.payer, intent.payee,
    intent.amount.toString(), intent.currency, intent.destinationId,
    intent.createdAt.toString(), intent.expiresAt.toString(),
  ]) {
    const encoded = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.length);
    hash.update(length);
    hash.update(encoded);
  }
  return hash.digest('hex');
}

function hasValidFundingIntentShape(intent: FundingIntentDraft): boolean {
  return intent.intentId.length > 0 && intent.provider.length > 0 && intent.destinationId.length > 0
    && intent.expiresAt >= intent.createdAt;
}
