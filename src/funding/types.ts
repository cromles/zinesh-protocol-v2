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
  readonly opaqueEvidence?: unknown;
}

/** Server-derived values against which provider evidence must be verified. */
export interface ExpectedFundingBinding {
  readonly gatewayPrincipalId: string;
  readonly cellId: CellId;
  readonly payer: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly destinationId: string;
}

export type FundingFinality =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'SETTLED'
  | 'REVERSED'
  | 'FAILED';

/** Created only by a trusted funding adapter after authoritative verification. */
export interface VerifiedFundingContext {
  readonly provider: string;
  readonly providerTransactionId: string;
  readonly gatewayPrincipalId: string;
  readonly cellId: CellId;
  readonly payer: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly destinationId: string;
  readonly confirmedAt: Timestamp;
  readonly finality: 'SETTLED';
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
  readonly receiptId: string;
  readonly provider: string;
  readonly providerTransactionId: string;
  readonly cellId: CellId;
  readonly commandId: CommandId;
  readonly fundingEventId: EventId;
  readonly gatewayPrincipalId: string;
  readonly payer: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly destinationId: string;
  readonly confirmedAt: Timestamp;
  readonly finality: 'SETTLED';
  readonly evidenceDigest: string;
  readonly verifiedAt: Timestamp;
  readonly createdAt: Timestamp;
}
