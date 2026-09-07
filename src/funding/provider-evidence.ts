import type { Amount, Currency, Timestamp } from '../core/types';

export type ProviderEnvironment = 'SANDBOX' | 'LIVE';
export type ProviderReconciliationState =
  | 'PENDING' | 'FUNDS_HELD' | 'FAILED' | 'CANCELLED'
  | 'REFUNDED' | 'REVERSED' | 'DISPUTED' | 'UNKNOWN';

export type ProviderAuthenticity = 'VERIFIED' | 'FAILED' | 'NOT_AVAILABLE';

/** Provider-neutral, selected evidence only. Raw payloads and payment secrets are forbidden. */
export interface NormalizedProviderEvidence {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly environment: ProviderEnvironment;
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
  readonly providerPaymentId: string;
  readonly providerTransactionId: string;
  readonly intentId: string;
  readonly receiptId?: string | undefined;
  readonly cellId?: string | undefined;
  readonly eventType: string;
  readonly payloadDigest: string;
  readonly normalizedEvidenceDigest?: string | undefined;
  readonly receivedAt: Timestamp;
}

export interface ProviderTransactionCorrelation {
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerTransactionId: string;
  readonly providerPaymentId: string;
  readonly intentId: string;
  readonly receiptId?: string | undefined;
  readonly cellId: string;
  readonly createdAt: Timestamp;
}

export interface ProviderReconciliationCheckpoint {
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerTransactionId: string;
  readonly state: ProviderReconciliationState;
  readonly normalizedEvidenceDigest?: string | undefined;
  readonly lastEventIdentity?: string | undefined;
  readonly attemptCount: number;
  readonly checkedAt: Timestamp;
  readonly nextAttemptAt?: Timestamp | undefined;
  readonly lastErrorCategory?: string | undefined;
}

export type ProviderNegativeObservationKind = 'REFUND' | 'REVERSAL' | 'DISPUTE';

export interface ProviderNegativeObservation {
  readonly observationId: string;
  readonly provider: string;
  readonly environment: ProviderEnvironment;
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
