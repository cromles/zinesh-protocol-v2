import type { CellId } from '../core/types';
import type { FundingDisputeObservation } from '../funding/types';

export type FundingDisputeRecordResult =
  | { readonly kind: 'RECORDED' }
  | { readonly kind: 'DUPLICATE'; readonly observation: FundingDisputeObservation }
  | { readonly kind: 'CONFLICT' };

export interface FundingDisputeStore {
  record(observation: FundingDisputeObservation): Promise<FundingDisputeRecordResult>;
  hasBlockingDispute(cellId: CellId): Promise<boolean>;
}

export function sameFundingDisputeObservation(
  left: FundingDisputeObservation, right: FundingDisputeObservation,
): boolean {
  return left.observationId === right.observationId && left.provider === right.provider
    && left.providerDisputeId === right.providerDisputeId
    && left.providerTransactionId === right.providerTransactionId
    && left.observationVersion === right.observationVersion && left.receiptId === right.receiptId
    && left.cellId === right.cellId && left.kind === right.kind && left.status === right.status
    && left.outcome === right.outcome
    && left.amount === right.amount && left.currency === right.currency
    && left.evidenceDigest === right.evidenceDigest && left.observedAt === right.observedAt;
}

export function isBlockingFundingDispute(outcome: FundingDisputeObservation['outcome']): boolean {
  return outcome !== 'FUNDS_RETAINED';
}

export function hasConsistentFundingDisputeLifecycle(observation: FundingDisputeObservation): boolean {
  return observation.status === 'OPEN' || observation.status === 'UNDER_REVIEW'
    ? observation.outcome === 'PENDING'
    : observation.outcome === 'FUNDS_RETAINED' || observation.outcome === 'FUNDS_LOST';
}

export function sameFundingDisputeBinding(
  left: FundingDisputeObservation, right: FundingDisputeObservation,
): boolean {
  return left.providerTransactionId === right.providerTransactionId && left.receiptId === right.receiptId
    && left.cellId === right.cellId && left.kind === right.kind && left.amount === right.amount
    && left.currency === right.currency;
}
