import type { FundingReceipt } from '../funding/types';

export type FundingReceiptConflict =
  | 'RECEIPT'
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
}

export function sameFundingReceiptIdentity(
  left: FundingReceipt,
  right: FundingReceipt,
): boolean {
  return left.provider === right.provider
    && left.providerTransactionId === right.providerTransactionId
    && left.cellId === right.cellId
    && left.commandId === right.commandId
    && left.fundingEventId === right.fundingEventId
    && left.gatewayPrincipalId === right.gatewayPrincipalId
    && left.payer === right.payer
    && left.amount === right.amount
    && left.currency === right.currency
    && left.destinationId === right.destinationId
    && left.confirmedAt === right.confirmedAt
    && left.finality === right.finality
    && left.evidenceDigest === right.evidenceDigest;
}
