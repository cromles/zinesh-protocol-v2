import type { Amount, Currency, Timestamp } from '../core/types';
import type { FundingEnvironment } from './types';

export type ProviderEnvironment = FundingEnvironment;
export type ProviderReconciliationState =
  | 'PENDING' | 'SETTLED' | 'FUNDS_HELD' | 'FAILED' | 'CANCELLED'
  | 'REFUNDED' | 'REFUND' | 'RETURNED' | 'REVERSED' | 'DISPUTE' | 'DISPUTED' | 'UNKNOWN';

export type ProviderAuthenticity = 'VERIFIED' | 'FAILED' | 'NOT_AVAILABLE';

/** Provider-neutral, selected evidence only. Raw payloads and payment secrets are forbidden. */
export interface NormalizedProviderEvidence {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerAccountScope: string;
  readonly providerTransactionId: string;
  readonly intentId: string;
  readonly providerPaymentId: string;
  readonly providerConversationId: string;
  readonly merchantReference?: string | undefined;
  readonly destinationReference?: string | undefined;
  readonly amountMinor: Amount;
  readonly currency: Currency;
  readonly providerStatus: string;
  readonly riskStatus?: string | undefined;
  readonly reconciliationState: ProviderReconciliationState;
  readonly providerOccurredAt?: Timestamp | undefined;
  readonly queriedAt: Timestamp;
  readonly responseAuthenticity: ProviderAuthenticity;
  readonly webhookReference?: string | undefined;
  readonly webhookAuthenticity?: ProviderAuthenticity | undefined;
  readonly rawPayloadDigest: string;
  readonly normalizedEvidenceDigest: string;
}

export interface ProviderEvent {
  readonly eventIdentity: string;
  readonly replayIdentity: string;
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerEventId?: string | undefined;
  readonly providerPaymentId?: string | undefined;
  readonly providerTransactionId: string;
  readonly intentId?: string | undefined;
  readonly receiptId?: string | undefined;
  readonly cellId?: string | undefined;
  readonly eventType: string;
  readonly payloadDigest: string;
  readonly normalizedEvidenceDigest?: string | undefined;
  readonly receivedAt: Timestamp;
}

/** Processing state is kept separately from the immutable provider event. */
export type ProviderEventProcessingState = 'RECEIVED' | 'CLAIMED' | 'PROCESSED' | 'FAILED';

export interface ProviderEventClaim {
  readonly eventIdentity: string;
  readonly workerId: string;
  readonly leaseUntil: Timestamp;
  readonly attemptCount: number;
}

export interface ProviderTransactionCorrelation {
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerAccountScope?: string | undefined;
  readonly providerTransactionId: string;
  readonly providerPaymentId?: string | undefined;
  readonly intentId: string;
  readonly receiptId?: string | undefined;
  readonly cellId: string;
  readonly createdAt: Timestamp;
}

export interface ProviderReconciliationCheckpoint {
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerAccountScope?: string | undefined;
  readonly providerTransactionId: string;
  readonly state: ProviderReconciliationState;
  readonly normalizedEvidenceDigest?: string | undefined;
  readonly lastEventIdentity?: string | undefined;
  readonly attemptCount: number;
  readonly checkedAt: Timestamp;
  readonly nextAttemptAt?: Timestamp | undefined;
  readonly lastErrorCategory?: string | undefined;
}

/** Account-level scan position; cursor is opaque and has no provider-specific shape. */
export interface ProviderAccountReconciliationCheckpoint {
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerAccountScope: string;
  readonly cursor?: string | undefined;
  readonly pageToken?: string | undefined;
  readonly statementSequence?: string | undefined;
  readonly lastObservedAt?: Timestamp | undefined;
  readonly checkedAt: Timestamp;
  readonly revision: number;
}

export type ProviderNegativeObservationKind = 'REFUND' | 'RETURNED' | 'REVERSAL' | 'DISPUTE';

export interface ProviderNegativeObservation {
  readonly observationId: string;
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerAccountScope?: string | undefined;
  readonly providerObservationId: string;
  readonly providerTransactionId: string;
  readonly intentId: string;
  readonly receiptId?: string | undefined;
  readonly cellId?: string | undefined;
  readonly kind: ProviderNegativeObservationKind;
  readonly amountMinor?: Amount | undefined;
  readonly currency?: Currency | undefined;
  readonly payloadDigest: string;
  readonly observedAt: Timestamp;
  readonly recordedAt: Timestamp;
}
