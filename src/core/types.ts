/**
 * ZINESH PROTOCOL V2 — Core Domain Types
 *
 * This file defines the domain contract.
 * All types are derived from the LOCKED DOMAIN SPEC v1.0.
 *
 * Rules encoded here:
 *   - No business logic (that lives in src/kernel/state-machine.ts)
 *   - No persistence concerns
 *   - No I/O
 */

// ---------------------------------------------------------------------------
// Identifiers (branded)
// ---------------------------------------------------------------------------

export type EventId    = string & { readonly __brand: 'EventId' };
export type CellId     = string & { readonly __brand: 'CellId' };
export type CommandId  = string & { readonly __brand: 'CommandId' };
export type ActorId    = string & { readonly __brand: 'ActorId' };

export function makeEventId(raw: string): EventId {
  if (raw.length === 0) throw new Error('EventId must not be empty');
  return raw as EventId;
}

export function makeCellId(raw: string): CellId {
  if (raw.length === 0) throw new Error('CellId must not be empty');
  return raw as CellId;
}

export function makeCommandId(raw: string): CommandId {
  if (raw.length === 0) throw new Error('CommandId must not be empty');
  return raw as CommandId;
}

export function makeActorId(raw: string): ActorId {
  if (raw.length === 0) throw new Error('ActorId must not be empty');
  return raw as ActorId;
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Monotonically increasing per-cell event counter.
 * Version 0 = no events applied (empty stream).
 * First event gets version 1.
 */
export type Version = number & { readonly __brand: 'Version' };

export const ZERO_VERSION = 0 as Version;

export function nextVersion(v: Version): Version {
  return (v + 1) as Version;
}

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

/**
 * Domain event timestamp: milliseconds since Unix epoch.
 * This value is authoritative.
 * Persistence layers must NEVER overwrite it with a DB-generated timestamp.
 */
export type Timestamp = number & { readonly __brand: 'Timestamp' };

export function makeTimestamp(ms: number): Timestamp {
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error(`Invalid timestamp: ${ms}`);
  }
  return ms as Timestamp;
}

// ---------------------------------------------------------------------------
// Currency & Amount
// ---------------------------------------------------------------------------

/** Only TRY is supported in this version. */
export type Currency = 'TRY';

/**
 * Monetary amount in kuruş (smallest TRY unit).
 * Must be a positive bigint. No floating point. No Decimal.
 */
export type Amount = bigint & { readonly __brand: 'Amount' };

export function makeAmount(kuruş: bigint): Amount {
  if (kuruş <= 0n) throw new Error(`Amount must be positive, got: ${kuruş}`);
  return kuruş as Amount;
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

export interface Participants {
  readonly payer: ActorId;
  readonly payee: ActorId;
  /** Arbiter is optional. If absent, dispute is not available. */
  readonly arbiter?: ActorId;
}

// ---------------------------------------------------------------------------
// Cell Status (locked domain state machine)
// ---------------------------------------------------------------------------

export type CellStatus =
  | 'CREATED'
  | 'FUNDED'
  | 'DISPUTED'
  | 'RELEASED'
  | 'REFUNDED'
  | 'EXPIRED';

export const TERMINAL_STATUSES: ReadonlySet<CellStatus> = new Set([
  'RELEASED',
  'REFUNDED',
  'EXPIRED',
]);

// ---------------------------------------------------------------------------
// Domain Event Payloads
// ---------------------------------------------------------------------------

export interface CellCreatedPayload {
  readonly payer: ActorId;
  readonly payee: ActorId;
  readonly arbiter?: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly fundingDeadline: Timestamp;
  readonly completionDeadline: Timestamp;
}

export interface CellFundedPayload {
  readonly fundedBy: ActorId;
  readonly amount: Amount;
}

export interface ReleaseRequestedPayload {
  readonly requestedBy: ActorId;
}

export interface ReleasedPayload {
  readonly approvedBy: ActorId;
}

export interface RefundRequestedPayload {
  readonly requestedBy: ActorId;
}

export interface RefundedPayload {
  readonly approvedBy: ActorId;
}

export interface CellExpiredPayload {
  readonly triggeredBy: ActorId;
  readonly currentTime: Timestamp;
}

export interface DisputeOpenedPayload {
  readonly openedBy: ActorId;
  readonly currentTime: Timestamp;
}

export interface DisputeResolvedPayload {
  readonly resolvedBy: ActorId;
  /** Which participant the arbiter decided in favour of. */
  readonly favourOf: 'payer' | 'payee';
}

// ---------------------------------------------------------------------------
// Domain Event discriminated union
// ---------------------------------------------------------------------------

export type DomainEvent =
  | { readonly type: 'CellCreated';      readonly payload: CellCreatedPayload }
  | { readonly type: 'CellFunded';       readonly payload: CellFundedPayload }
  | { readonly type: 'ReleaseRequested'; readonly payload: ReleaseRequestedPayload }
  | { readonly type: 'Released';         readonly payload: ReleasedPayload }
  | { readonly type: 'RefundRequested';  readonly payload: RefundRequestedPayload }
  | { readonly type: 'Refunded';         readonly payload: RefundedPayload }
  | { readonly type: 'CellExpired';      readonly payload: CellExpiredPayload }
  | { readonly type: 'DisputeOpened';    readonly payload: DisputeOpenedPayload }
  | { readonly type: 'DisputeResolved';  readonly payload: DisputeResolvedPayload };

export type DomainEventType = DomainEvent['type'];

// ---------------------------------------------------------------------------
// Envelope — Event with kernel-assigned metadata
// ---------------------------------------------------------------------------

/**
 * A stored domain event, fully enveloped with kernel-assigned fields.
 * Generic parameter narrows the payload type for type-safe reconstruction.
 */
export interface Event<T extends DomainEvent = DomainEvent> {
  readonly eventId: EventId;
  readonly cellId: CellId;
  readonly version: Version;
  /** Domain timestamp — set by the caller via DeterministicContext, never by DB. */
  readonly timestamp: Timestamp;
  readonly type: T['type'];
  readonly payload: T['payload'];
}

// ---------------------------------------------------------------------------
// Cell State (reconstructed from events)
// ---------------------------------------------------------------------------

/**
 * Full cell state as reconstructed by replaying events.
 * The kernel derives this; it is never persisted as an authoritative record.
 */
export interface CellState {
  readonly cellId: CellId;
  readonly status: CellStatus;

  // Immutable fields set at creation and never changed
  readonly payer: ActorId;
  readonly payee: ActorId;
  readonly arbiter?: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly fundingDeadline: Timestamp;
  readonly completionDeadline: Timestamp;

  // Mutable tracking fields
  readonly fundedAt?: Timestamp;
  readonly releaseRequestedBy?: ActorId;
  readonly refundRequestedBy?: ActorId;
}

// ---------------------------------------------------------------------------
// Command Payloads
// ---------------------------------------------------------------------------

export interface CreateCellPayload {
  readonly payer: ActorId;
  readonly payee: ActorId;
  readonly arbiter?: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
  readonly fundingDeadline: Timestamp;
  readonly completionDeadline: Timestamp;
}

export interface FundCellPayload {
  readonly funderId: ActorId;
  readonly amount: Amount;
}

export interface RequestReleasePayload {
  readonly requestedBy: ActorId;
}

export interface ApproveReleasePayload {
  readonly approvedBy: ActorId;
}

export interface RequestRefundPayload {
  readonly requestedBy: ActorId;
}

export interface ApproveRefundPayload {
  readonly approvedBy: ActorId;
}

export interface ForceRefundPayload {
  readonly requestedBy: ActorId;
  readonly currentTime: Timestamp;
}

export interface ExpireCellPayload {
  readonly triggeredBy: ActorId;
  readonly currentTime: Timestamp;
}

export interface OpenDisputePayload {
  readonly openedBy: ActorId;
  readonly currentTime: Timestamp;
}

export interface ResolveDisputePayload {
  readonly resolvedBy: ActorId;
  readonly favourOf: 'payer' | 'payee';
}

// ---------------------------------------------------------------------------
// Command discriminated union
// ---------------------------------------------------------------------------

export type DomainCommand =
  | { readonly type: 'CreateCell';      readonly payload: CreateCellPayload }
  | { readonly type: 'FundCell';        readonly payload: FundCellPayload }
  | { readonly type: 'RequestRelease';  readonly payload: RequestReleasePayload }
  | { readonly type: 'ApproveRelease';  readonly payload: ApproveReleasePayload }
  | { readonly type: 'RequestRefund';   readonly payload: RequestRefundPayload }
  | { readonly type: 'ApproveRefund';   readonly payload: ApproveRefundPayload }
  | { readonly type: 'ForceRefund';     readonly payload: ForceRefundPayload }
  | { readonly type: 'ExpireCell';      readonly payload: ExpireCellPayload }
  | { readonly type: 'OpenDispute';     readonly payload: OpenDisputePayload }
  | { readonly type: 'ResolveDispute';  readonly payload: ResolveDisputePayload };

export type DomainCommandType = DomainCommand['type'];

// ---------------------------------------------------------------------------
// Command envelope (carries cellId + commandId alongside domain command)
// ---------------------------------------------------------------------------

export interface Command {
  readonly commandId: CommandId;
  readonly cellId: CellId;
  readonly type: DomainCommandType;
  readonly payload: DomainCommand['payload'];
}

// ---------------------------------------------------------------------------
// Deterministic Context
// ---------------------------------------------------------------------------

/**
 * Externally supplied — the kernel must NOT call Date.now(), Math.random(),
 * or generate UUIDs itself. All time and identity values come from this context.
 */
export interface DeterministicContext {
  readonly now: Timestamp;
  /**
   * Returns a fresh EventId for the nth event (0-indexed) produced within
   * a single command application.
   */
  readonly nextEventId: (index: number) => EventId;
}

// ---------------------------------------------------------------------------
// Kernel Result
// ---------------------------------------------------------------------------

export type KernelResult =
  | { readonly ok: true;  readonly events: ReadonlyArray<Event>; readonly nextState: CellState }
  | { readonly ok: false; readonly error: KernelError };

// ---------------------------------------------------------------------------
// Kernel Error
// ---------------------------------------------------------------------------

export type KernelErrorCode =
  | 'ILLEGAL_TRANSITION'
  | 'INVARIANT_VIOLATION'
  | 'UNKNOWN_COMMAND'
  | 'PRECONDITION_FAILED'
  | 'AUTHORIZATION_DENIED'
  | 'DEADLINE_VIOLATION'
  | 'STREAM_INTEGRITY_ERROR';

export interface KernelError {
  readonly code: KernelErrorCode;
  readonly message: string;
}

export function kernelError(code: KernelErrorCode, message: string): KernelError {
  return { code, message };
}
