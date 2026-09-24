import type { Amount, Currency, Timestamp } from '../core/types';
import type { ProviderEnvironment } from './provider-evidence';

export type FundingRouteStatus = 'ACTIVE' | 'EXPIRED' | 'CLOSED';

/** A provider-neutral address/reference for one immutable funding intent. */
export interface FundingRoute {
  readonly routeId: string;
  readonly intentId: string;
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerAccountScope: string;
  readonly destinationReference: string;
  readonly currency: Currency;
  readonly expectedAmount: Amount;
  readonly status: FundingRouteStatus;
  readonly createdAt: Timestamp;
  readonly expiresAt?: Timestamp | undefined;
}

export type FundingObservationDirection = 'CREDIT' | 'DEBIT';
export type FundingObservationState =
  | 'PENDING'
  | 'SETTLED'
  | 'FUNDS_HELD'
  | 'RETURNED'
  | 'REVERSED'
  | 'REFUND'
  | 'DISPUTE'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'DISPUTED'
  | 'UNKNOWN';
export type FundingObservationCorrelationStatus = 'UNMATCHED' | 'MATCHED';

/** Normalized financial fact. No provider payload or credential is retained. */
export interface FundingObservation {
  readonly observationId: string;
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerAccountScope: string;
  readonly providerTransactionId: string;
  /** Parent funding transaction when this observation is a return/refund/reversal. */
  readonly relatedProviderTransactionId?: string | undefined;
  readonly direction: FundingObservationDirection;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly observedAt: Timestamp;
  readonly bookedAt?: Timestamp | undefined;
  readonly destinationReference?: string | undefined;
  readonly rawPayloadDigest: string;
  readonly state: FundingObservationState;
}

/** Lookup absence is not a financial transaction state and must remain separate. */
export type FundingObservationLookupResult =
  | { readonly outcome: 'OBSERVED'; readonly observation: FundingObservation }
  | { readonly outcome: 'NOT_FOUND'; readonly checkedAt: Timestamp }
  | { readonly outcome: 'UNAVAILABLE'; readonly checkedAt: Timestamp };

export interface FundingObservationEnvelope {
  readonly observation: FundingObservation;
  readonly correlationStatus: FundingObservationCorrelationStatus;
  readonly intentId?: string | undefined;
  readonly correlationReason?: 'NO_ROUTE' | 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'DESTINATION_MISMATCH' | undefined;
}

export type FundingReconciliationOutcome =
  | { readonly kind: 'UNMATCHED'; readonly reason: NonNullable<FundingObservationEnvelope['correlationReason']> | 'TRANSACTION_CONFLICT' }
  | { readonly kind: 'PENDING'; readonly intentId: string }
  | { readonly kind: 'SETTLED'; readonly intentId: string }
  | { readonly kind: 'FUNDS_HELD'; readonly intentId: string }
  | { readonly kind: 'UNKNOWN'; readonly intentId: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNAVAILABLE' }
  | { readonly kind: 'NEGATIVE'; readonly intentId: string; readonly state: Exclude<FundingObservationState, 'PENDING' | 'SETTLED' | 'FUNDS_HELD' | 'UNKNOWN'> }
  | { readonly kind: 'DUPLICATE'; readonly observation: FundingObservationEnvelope };

export function isFundingObservationDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function hasValidFundingRoute(route: FundingRoute): boolean {
  return route.routeId.length > 0 && route.intentId.length > 0 && route.provider.length > 0
    && route.providerAccountScope.length > 0 && route.destinationReference.length > 0
    && route.expectedAmount > 0n && (route.expiresAt === undefined || route.expiresAt >= route.createdAt);
}

export function hasValidFundingObservation(observation: FundingObservation): boolean {
  return observation.observationId.length > 0 && observation.provider.length > 0
    && observation.providerAccountScope.length > 0 && observation.providerTransactionId.length > 0
    && observation.amount > 0n && isFundingObservationDigest(observation.rawPayloadDigest)
    && (observation.bookedAt === undefined || observation.bookedAt >= 0);
}
