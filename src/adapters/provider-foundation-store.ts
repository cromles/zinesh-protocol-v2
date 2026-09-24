import type { ProviderEvent, ProviderNegativeObservation, ProviderReconciliationCheckpoint,
  ProviderTransactionCorrelation, ProviderAccountReconciliationCheckpoint, ProviderEventClaim,
  ProviderEventProcessingState } from '../funding/provider-evidence';
import type { FundingObservation, FundingObservationEnvelope, FundingRoute } from '../funding/funding-foundation';
import type { ProviderNegativeDisposition } from '../funding/types';

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
export type ProviderNegativeDispositionResult = 'RECORDED' | 'DUPLICATE' | 'CONFLICT';

export type FundingRouteCreateResult =
  | { readonly kind: 'CREATED' }
  | { readonly kind: 'DUPLICATE'; readonly route: FundingRoute }
  | { readonly kind: 'CONFLICT' };
export type FundingObservationRecordResult =
  | { readonly kind: 'RECORDED' }
  | { readonly kind: 'DUPLICATE'; readonly observation: FundingObservationEnvelope }
  | { readonly kind: 'CONFLICT' };
export type ProviderEventClaimResult =
  | { readonly kind: 'CLAIMED'; readonly claim: ProviderEventClaim }
  | { readonly kind: 'BUSY' }
  | { readonly kind: 'PROCESSED' }
  | { readonly kind: 'NOT_FOUND' };
export type ProviderEventCompletionResult = 'PROCESSED' | 'FAILED' | 'NOT_CLAIMED' | 'NOT_FOUND';

export interface ProviderFoundationStore {
  recordEvent(event: ProviderEvent): Promise<ProviderEventRecordResult>;
  getEvent(eventIdentity: string): Promise<ProviderEvent | null>;
  listClaimableEvents(now: number, limit: number): Promise<ReadonlyArray<string>>;
  claimEvent(eventIdentity: string, workerId: string, now: number, leaseMs: number): Promise<ProviderEventClaimResult>;
  completeEvent(eventIdentity: string, workerId: string, now: number): Promise<ProviderEventCompletionResult>;
  failEvent(eventIdentity: string, workerId: string, now: number, errorCategory: string): Promise<ProviderEventCompletionResult>;
  correlateTransaction(correlation: ProviderTransactionCorrelation): Promise<ProviderCorrelationResult>;
  getCorrelation(provider: string, environment: string, providerTransactionId: string,
    providerAccountScope?: string): Promise<ProviderTransactionCorrelation | null>;
  createRoute(route: FundingRoute): Promise<FundingRouteCreateResult>;
  getRouteByIntent(provider: string, environment: string, intentId: string): Promise<FundingRoute | null>;
  findRoute(provider: string, environment: string, providerAccountScope: string,
    destinationReference: string): Promise<FundingRoute | null>;
  recordObservation(observation: FundingObservation): Promise<FundingObservationRecordResult>;
  getObservation(provider: string, environment: string, providerAccountScope: string,
    observationId: string): Promise<FundingObservationEnvelope | null>;
  listUnmatchedObservations(provider: string, environment: string, providerAccountScope: string,
    limit: number): Promise<ReadonlyArray<FundingObservationEnvelope>>;
  putCheckpoint(checkpoint: ProviderReconciliationCheckpoint): Promise<void>;
  getCheckpoint(provider: string, environment: string,
    providerTransactionId: string, providerAccountScope?: string): Promise<ProviderReconciliationCheckpoint | null>;
  putAccountCheckpoint(checkpoint: ProviderAccountReconciliationCheckpoint): Promise<boolean>;
  getAccountCheckpoint(provider: string, environment: string,
    providerAccountScope: string): Promise<ProviderAccountReconciliationCheckpoint | null>;
  appendNegativeObservation(observation: ProviderNegativeObservation):
    Promise<ProviderNegativeObservationResult>;
  getNegativeObservation(observationId: string): Promise<ProviderNegativeObservation | null>;
  appendNegativeDisposition(disposition: ProviderNegativeDisposition): Promise<ProviderNegativeDispositionResult>;
  listNegativeDispositions(cellId: string): Promise<ReadonlyArray<ProviderNegativeDisposition>>;
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
    && (a.providerAccountScope ?? 'DEFAULT') === (b.providerAccountScope ?? 'DEFAULT')
    && a.providerTransactionId === b.providerTransactionId
    && a.providerPaymentId === b.providerPaymentId && a.intentId === b.intentId
    && a.receiptId === b.receiptId && a.cellId === b.cellId;
}

export function sameProviderNegativeObservation(a: ProviderNegativeObservation,
  b: ProviderNegativeObservation): boolean {
  return a.observationId === b.observationId && a.provider === b.provider
    && a.environment === b.environment && (a.providerAccountScope ?? 'DEFAULT') === (b.providerAccountScope ?? 'DEFAULT')
    && a.providerObservationId === b.providerObservationId
    && a.providerTransactionId === b.providerTransactionId && a.intentId === b.intentId
    && a.receiptId === b.receiptId && a.cellId === b.cellId && a.kind === b.kind
    && a.amountMinor === b.amountMinor && a.currency === b.currency
    && a.payloadDigest === b.payloadDigest && a.observedAt === b.observedAt
    && a.recordedAt === b.recordedAt;
}
