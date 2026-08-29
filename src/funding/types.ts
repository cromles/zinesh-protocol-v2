import type {
  ActorId,
  Amount,
  CellId,
  CommandId,
  Currency,
  EventId,
  Timestamp,
} from '../core/types';

/** Untrusted provider-neutral input. Provider adapters own opaqueEvidence. */
export interface FundingEvidence {
  readonly provider: string;
  readonly providerTransactionId: string;
  readonly intentId: string;
  readonly opaqueEvidence?: unknown;
}

/** Trusted cell fields used to resolve a provider custody destination. */
export interface FundingDestinationBinding {
  readonly provider: string;
  readonly cellId: CellId;
  readonly payer: ActorId;
  readonly payee: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
}

/** Server-derived values against which provider evidence must be verified. */
export interface ExpectedFundingBinding {
  readonly intentId: string;
  readonly gatewayPrincipalId: string;
  readonly cellId: CellId;
  readonly payer: ActorId;
  readonly payee: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly destinationId: string;
}

export type FundingFinality =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'FUNDS_HELD'
  | 'REVERSED'
  | 'FAILED';

/** Created only by a trusted funding adapter after authoritative verification. */
export interface VerifiedFundingContext {
  readonly intentId: string;
  readonly provider: string;
  readonly providerTransactionId: string;
  readonly gatewayPrincipalId: string;
  readonly cellId: CellId;
  readonly payer: ActorId;
  readonly payee: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly destinationId: string;
  readonly confirmedAt: Timestamp;
  readonly finality: 'FUNDS_HELD';
  readonly evidenceDigest: string;
  readonly verifiedAt: Timestamp;
}

export type FundingVerificationResult =
  | { readonly outcome: 'VERIFIED'; readonly context: VerifiedFundingContext }
  | {
      readonly outcome: 'INVALID';
      readonly reason:
        | 'UNKNOWN_TRANSACTION'
        | 'AUTHENTICITY_FAILED'
        | 'BINDING_MISMATCH'
        | 'UNSUPPORTED_PAYMENT'
        | 'FAILED'
        | 'REVERSED';
    }
  | {
      readonly outcome: 'NOT_FINAL';
      readonly observedFinality: 'PENDING' | 'AUTHORIZED' | 'CAPTURED';
    }
  | { readonly outcome: 'DEPENDENCY_UNAVAILABLE' };

/** Immutable financial provenance committed atomically with CellFunded. */
export interface FundingReceipt {
  readonly intentId: string;
  readonly receiptId: string;
  readonly provider: string;
  readonly providerTransactionId: string;
  readonly cellId: CellId;
  readonly commandId: CommandId;
  readonly fundingEventId: EventId;
  readonly gatewayPrincipalId: string;
  readonly payer: ActorId;
  readonly payee: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly destinationId: string;
  readonly confirmedAt: Timestamp;
  readonly finality: 'FUNDS_HELD' | 'SETTLED_LEGACY';
  readonly evidenceDigest: string;
  readonly verifiedAt: Timestamp;
  readonly createdAt: Timestamp;
}

/** Immutable server-created authorization to attempt one exact funding binding. */
export interface FundingIntent {
  readonly intentId: string;
  readonly provider: string;
  readonly cellId: CellId;
  readonly payer: ActorId;
  readonly payee: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly destinationId: string;
  readonly bindingDigest: string;
  readonly createdAt: Timestamp;
  readonly expiresAt: Timestamp;
}

export type FundingDisputeKind = 'CHARGEBACK' | 'REVERSAL' | 'REFUND';
export type FundingDisputeStatus = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'CLOSED';
export type FundingDisputeOutcome = 'PENDING' | 'FUNDS_RETAINED' | 'FUNDS_LOST';

/** Append-only provider financial-risk observation; distinct from escrow-domain disputes. */
export interface FundingDisputeObservation {
  readonly observationId: string;
  readonly provider: string;
  readonly providerDisputeId: string;
  readonly providerTransactionId: string;
  readonly observationVersion: bigint;
  readonly receiptId: string;
  readonly cellId: CellId;
  readonly kind: FundingDisputeKind;
  readonly status: FundingDisputeStatus;
  readonly outcome: FundingDisputeOutcome;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly evidenceDigest: string;
  readonly observedAt: Timestamp;
  readonly recordedAt: Timestamp;
}
