import type { FundingReceipt } from '../funding/types';

export type FundingReceiptConflict =
  | 'RECEIPT'
  | 'INTENT'
  | 'PROVIDER_TRANSACTION'
  | 'CELL'
  | 'COMMAND'
  | 'EVENT';

export type FundingReceiptClaimResult =
  | { readonly kind: 'CLAIMED' }
  | { readonly kind: 'DUPLICATE'; readonly receipt: FundingReceipt }
  | { readonly kind: 'CONFLICT'; readonly conflict: FundingReceiptConflict };

/**
 * Transaction-scoped financial uniqueness boundary. Implementations must not
 * expose mutation or deletion operations for committed receipts.
 */
export interface FundingReceiptStore {
  claim(receipt: FundingReceipt): Promise<FundingReceiptClaimResult>;
  getById(receiptId: string): Promise<FundingReceipt | null>;
}

export function sameFundingReceiptIdentity(
  left: FundingReceipt,
  right: FundingReceipt,
): boolean {
  return left.intentId === right.intentId
    && left.provider === right.provider
    && left.environment === right.environment
    && left.providerAccountScope === right.providerAccountScope
    && left.providerTransactionId === right.providerTransactionId
    && left.cellId === right.cellId
    && left.commandId === right.commandId
    && left.fundingEventId === right.fundingEventId
    && left.gatewayPrincipalId === right.gatewayPrincipalId
    && left.payer === right.payer
    && left.payee === right.payee
    && left.amount === right.amount
    && left.currency === right.currency
    && left.destinationId === right.destinationId
    && left.confirmedAt === right.confirmedAt
    && left.finality === right.finality
    && left.evidenceDigest === right.evidenceDigest;
}
