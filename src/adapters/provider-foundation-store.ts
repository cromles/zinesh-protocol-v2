import type { ProviderEvent, ProviderNegativeObservation, ProviderReconciliationCheckpoint,
  ProviderTransactionCorrelation } from '../funding/provider-evidence';

export type ProviderEventRecordResult =
  | { readonly kind: 'FIRST_SEEN' }
  | { readonly kind: 'DUPLICATE'; readonly event: ProviderEvent }
  | { readonly kind: 'CONFLICTING_DUPLICATE' }
  | { readonly kind: 'REPLAY_PAYLOAD_CONFLICT' };

export type ProviderCorrelationResult =
  | { readonly kind: 'RECORDED' }
  | { readonly kind: 'DUPLICATE'; readonly correlation: ProviderTransactionCorrelation }
  | { readonly kind: 'CONFLICT' };

export type ProviderNegativeObservationResult =
  | { readonly kind: 'RECORDED' }
  | { readonly kind: 'DUPLICATE'; readonly observation: ProviderNegativeObservation }
  | { readonly kind: 'CONFLICT' };

export interface ProviderFoundationStore {
  recordEvent(event: ProviderEvent): Promise<ProviderEventRecordResult>;
  correlateTransaction(correlation: ProviderTransactionCorrelation): Promise<ProviderCorrelationResult>;
  putCheckpoint(checkpoint: ProviderReconciliationCheckpoint): Promise<void>;
  getCheckpoint(provider: string, environment: string,
    providerTransactionId: string): Promise<ProviderReconciliationCheckpoint | null>;
  appendNegativeObservation(observation: ProviderNegativeObservation):
    Promise<ProviderNegativeObservationResult>;
}

export function sameProviderEvent(a: ProviderEvent, b: ProviderEvent): boolean {
  return a.eventIdentity === b.eventIdentity && a.replayIdentity === b.replayIdentity
    && a.provider === b.provider && a.environment === b.environment
    && a.providerEventId === b.providerEventId && a.providerPaymentId === b.providerPaymentId
    && a.providerTransactionId === b.providerTransactionId && a.intentId === b.intentId
    && a.receiptId === b.receiptId && a.cellId === b.cellId && a.eventType === b.eventType
    && a.payloadDigest === b.payloadDigest
    && a.normalizedEvidenceDigest === b.normalizedEvidenceDigest && a.receivedAt === b.receivedAt;
}

export function sameProviderCorrelation(a: ProviderTransactionCorrelation,
  b: ProviderTransactionCorrelation): boolean {
  return a.provider === b.provider && a.environment === b.environment
    && a.providerTransactionId === b.providerTransactionId
    && a.providerPaymentId === b.providerPaymentId && a.intentId === b.intentId
    && a.receiptId === b.receiptId && a.cellId === b.cellId;
}
