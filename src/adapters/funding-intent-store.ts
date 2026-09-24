import type { FundingIntent } from '../funding/types';

export type FundingIntentCreateResult =
  | { readonly kind: 'CREATED' }
  | { readonly kind: 'DUPLICATE'; readonly intent: FundingIntent }
  | { readonly kind: 'INVALID' }
  | { readonly kind: 'CONFLICT' };

export interface FundingIntentStore {
  create(intent: FundingIntent): Promise<FundingIntentCreateResult>;
  get(intentId: string): Promise<FundingIntent | null>;
}

export function sameFundingIntent(left: FundingIntent, right: FundingIntent): boolean {
  return left.intentId === right.intentId && left.provider === right.provider
    && left.environment === right.environment && left.providerAccountScope === right.providerAccountScope
    && left.cellId === right.cellId && left.payer === right.payer && left.payee === right.payee
    && left.amount === right.amount && left.currency === right.currency
    && left.destinationId === right.destinationId && left.bindingDigest === right.bindingDigest
    && left.createdAt === right.createdAt && left.expiresAt === right.expiresAt;
}
