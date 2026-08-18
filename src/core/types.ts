/**
 * Zinesh 2.0 - Core Domain Types
 * 
 * This module defines the foundational, immutable types for the M1 Independent Escrow Cells protocol.
 * All types are designed to enforce invariants at compile-time using TypeScript's type system.
 * 
 * @see docs/ARCHITECTURE.md - System architecture overview
 * @see docs/INVARIANTS.md - Protocol invariants and safety properties
 */

// ============================================================================
// BRANDED TYPES - Prevent ID mixing at compile-time
// ============================================================================

/**
 * Uniquely identifies an escrow cell.
 * Branded to prevent accidental mixing with other string-based IDs.
 * 
 * @invariant Context Binding - Commands must match the CellId of their target state
 */
export type CellId = string & { readonly __brand: unique symbol };

/**
 * Helper to create a CellId from a string.
 * In production, use a proper UUID generator.
 */
export function createCellId(id: string): CellId {
  return id as CellId;
}

// ============================================================================
// ASSET & AMOUNT TYPES - Conservation of funds enforcement
// ============================================================================

/**
 * Reference to an asset (e.g., token address, currency code).
 * Opaque identifier - interpretation is left to the periphery.
 */
export type AssetRef = string & { readonly __brand: unique symbol };

export function createAssetRef(ref: string): AssetRef {
  return ref as AssetRef;
}

/**
 * Amount in smallest divisible units (e.g., wei, satoshis).
 * Uses bigint to prevent precision loss and overflow issues.
 * 
 * @invariant Conservation - Amounts must be non-negative
 * @invariant No overflow - Arithmetic must be checked
 */
export type Amount = bigint;

/**
 * Helper to create an Amount from a bigint.
 */
export function createAmount(value: bigint): Amount {
  if (value < 0n) {
    throw new ZineshError(
      ZineshErrorCode.PolicyViolation,
      'Amount cannot be negative'
    );
  }
  return value;
}

// ============================================================================
// PARTY ROLES - Authorization context
// ============================================================================

/**
 * Roles within an escrow cell.
 * Each role has specific permissions for commands.
 */
export const PartyRole = {
  Payer: 'Payer' as const,      // Initiator, funds the escrow
  Payee: 'Payee' as const,      // Recipient, receives on successful completion
  Arbiter: 'Arbiter' as const,  // Dispute resolver (optional)
} as const;

export type PartyRole = (typeof PartyRole)[keyof typeof PartyRole];

/**
 * Party definition within a cell.
 */
export interface Party {
  readonly role: PartyRole;
  readonly address: string; // Opaque - interpreted by periphery
}

// ============================================================================
// POLICY - Rules of the escrow
// ============================================================================

/**
 * The policy defines the rules and constraints for an escrow cell.
 * Once set, the policy is immutable for the lifetime of the cell.
 * 
 * @invariant Funding Finality - Exit paths require funded amount = policy amount
 */
export interface Policy {
  /** Unique identifier for this policy (for audit/replay purposes) */
  readonly id: string;
  
  /** The asset being escrowed */
  readonly asset: AssetRef;
  
  /** The exact amount to be escrowed */
  readonly amount: Amount;
  
  /** Unix timestamp when the escrow times out (seconds since epoch) */
  readonly timeout: number;
  
  /** Address authorized to resolve disputes (optional) */
  readonly arbiter?: string;
  
  /** Optional metadata or terms reference */
  readonly termsHash?: string;
}

// ============================================================================
// CELL STATE - State machine states
// ============================================================================

/**
 * The lifecycle states of an escrow cell.
 * Transitions are strictly controlled by the state machine.
 * 
 * Allowed transitions:
 *   Draft → AwaitingFunding → FundedLocked → ReleaseRequested → Closed
 *                                           ↓
 *                                     RefundRequested → Closed
 *                                           ↓
 *                                         Disputed → Closed
 *   
 *   Any State → Terminated (on policy violation or timeout)
 */
export const CellState = {
  /** Initial state - cell created, awaiting configuration */
  Draft: 'Draft' as const,
  
  /** Policy set, waiting for funds to arrive */
  AwaitingFunding: 'AwaitingFunding' as const,
  
  /** Funds bound and locked, awaiting resolution */
  FundedLocked: 'FundedLocked' as const,
  
  /** Payee has requested release */
  ReleaseRequested: 'ReleaseRequested' as const,
  
  /** Payer has requested refund */
  RefundRequested: 'RefundRequested' as const,
  
  /** Dispute opened, awaiting arbiter decision */
  Disputed: 'Disputed' as const,
  
  /** Successfully completed (released or refunded) */
  Closed: 'Closed' as const,
  
  /** Ended due to policy violation or timeout */
  Terminated: 'Terminated' as const,
} as const;

export type CellState = (typeof CellState)[keyof typeof CellState];

// ============================================================================
// COMMANDS - Intentions to mutate state
// ============================================================================

/**
 * Base command structure.
 * All commands must include cellId for context binding.
 */
export interface BaseCommand {
  readonly cellId: CellId;
  readonly commandId: string; // For replay detection
  readonly timestamp: number;
  readonly actor: PartyRole; // Role of the command issuer for authorization
}

/**
 * Create a new escrow cell.
 * Authorized by: Payer (initiator)
 */
export interface CreateCellCommand extends BaseCommand {
  readonly type: 'CreateCell';
  readonly payer: string;
  readonly payee: string;
  readonly policy: Policy;
  // actor must be PartyRole.Payer for CreateCell
}

/**
 * Bind funding to a cell.
 * Authorized by: System (on-chain confirmation)
 * 
 * @invariant Funding Finality - Must complete before exit paths
 */
export interface BindFundingCommand extends BaseCommand {
  readonly type: 'BindFunding';
  readonly actualAmount: Amount;
  readonly fundingTxHash: string;
  // actor is informational for BindFunding (system action)
}

/**
 * Request release of funds to payee.
 * Authorized by: Payee
 */
export interface RequestReleaseCommand extends BaseCommand {
  readonly type: 'RequestRelease';
  readonly recipientAddress: string;
  // actor must be PartyRole.Payee for RequestRelease
}

/**
 * Request refund of funds to payer.
 * Authorized by: Payer
 */
export interface RequestRefundCommand extends BaseCommand {
  readonly type: 'RequestRefund';
  readonly refundAddress: string;
  // actor must be PartyRole.Payer for RequestRefund
}

/**
 * Open a dispute for arbiter resolution.
 * Authorized by: Payer or Payee
 */
export interface OpenDisputeCommand extends BaseCommand {
  readonly type: 'OpenDispute';
  readonly reason: string;
  readonly evidenceHash?: string;
  // actor must be PartyRole.Payer or PartyRole.Payee
}

/**
 * Resolve a dispute (arbiter action).
 * Authorized by: Arbiter
 */
export interface ResolveDisputeCommand extends BaseCommand {
  readonly type: 'ResolveDispute';
  readonly decideFor: 'Payer' | 'Payee';
  readonly releaseAmount: Amount;
  readonly refundAmount: Amount;
  // actor must be PartyRole.Arbiter for ResolveDispute
}

/**
 * Trigger timeout-based refund.
 * Authorized by: Any party (after timeout)
 */
export interface TriggerTimeoutCommand extends BaseCommand {
  readonly type: 'TriggerTimeout';
  readonly currentTime: number;
  // actor can be any party for TriggerTimeout
}

/**
 * Union type of all valid commands.
 */
export type Command =
  | CreateCellCommand
  | BindFundingCommand
  | RequestReleaseCommand
  | RequestRefundCommand
  | OpenDisputeCommand
  | ResolveDisputeCommand
  | TriggerTimeoutCommand;

// ============================================================================
// EVENTS - Immutable records of what happened
// ============================================================================

/**
 * Base event structure.
 */
export interface BaseEvent {
  readonly eventId: string;
  readonly cellId: CellId;
  readonly timestamp: number;
  readonly version: number; // Event version for schema evolution
}

/**
 * Cell was created.
 */
export interface CellCreatedEvent extends BaseEvent {
  readonly type: 'CellCreated';
  readonly payer: string;
  readonly payee: string;
  readonly policy: Policy;
}

/**
 * Funding was bound to the cell.
 */
export interface FundingBoundEvent extends BaseEvent {
  readonly type: 'FundingBound';
  readonly amount: Amount;
  readonly fundingTxHash: string;
}

/**
 * Release was requested.
 */
export interface ReleaseRequestedEvent extends BaseEvent {
  readonly type: 'ReleaseRequested';
  readonly recipientAddress: string;
}

/**
 * Refund was requested.
 */
export interface RefundRequestedEvent extends BaseEvent {
  readonly type: 'RefundRequested';
  readonly refundAddress: string;
}

/**
 * Dispute was opened.
 */
export interface DisputeOpenedEvent extends BaseEvent {
  readonly type: 'DisputeOpened';
  readonly reason: string;
  readonly evidenceHash?: string | undefined;
}

/**
 * Dispute was resolved.
 */
export interface DisputeResolvedEvent extends BaseEvent {
  readonly type: 'DisputeResolved';
  readonly decidedFor: 'Payer' | 'Payee';
  readonly releaseAmount: Amount;
  readonly refundAmount: Amount;
}

/**
 * Cell was released (funds sent to payee).
 */
export interface CellReleasedEvent extends BaseEvent {
  readonly type: 'CellReleased';
  readonly amount: Amount;
  readonly recipientAddress: string;
  readonly txHash?: string;
}

/**
 * Cell was refunded (funds returned to payer).
 */
export interface CellRefundedEvent extends BaseEvent {
  readonly type: 'CellRefunded';
  readonly amount: Amount;
  readonly refundAddress: string;
  readonly txHash?: string;
}

/**
 * Cell was terminated (policy violation or timeout).
 */
export interface CellTerminatedEvent extends BaseEvent {
  readonly type: 'CellTerminated';
  readonly reason: string;
  readonly refundAmount?: Amount;
}

/**
 * Union type of all valid events.
 */
export type Event =
  | CellCreatedEvent
  | FundingBoundEvent
  | ReleaseRequestedEvent
  | RefundRequestedEvent
  | DisputeOpenedEvent
  | DisputeResolvedEvent
  | CellReleasedEvent
  | CellRefundedEvent
  | CellTerminatedEvent;

// ============================================================================
// DOMAIN ERRORS - Explicit error handling
// ============================================================================

/**
 * Error codes for domain-level errors.
 * Using enum for exhaustive checking and type safety.
 */
export const ZineshErrorCode = {
  /** State transition is not allowed from current state */
  InvalidStateTransition: 'InvalidStateTransition' as const,
  
  /** Funding has not been bound yet */
  FundingNotBound: 'FundingNotBound' as const,
  
  /** Command cellId does not match target state cellId */
  ContextMismatch: 'ContextMismatch' as const,
  
  /** Command/event has already been processed */
  ReplayDetected: 'ReplayDetected' as const,
  
  /** Command violates policy constraints */
  PolicyViolation: 'PolicyViolation' as const,
  
  /** Caller is not authorized for this action */
  Unauthorized: 'Unauthorized' as const,
  
  /** Timeout has not yet occurred */
  TimeoutNotReached: 'TimeoutNotReached' as const,
  
  /** Invalid amount (negative, overflow, etc.) */
  InvalidAmount: 'InvalidAmount' as const,
  
  /** Cell not found */
  CellNotFound: 'CellNotFound' as const,
} as const;

export type ZineshErrorCode = (typeof ZineshErrorCode)[keyof typeof ZineshErrorCode];

/**
 * Domain error class for protocol violations.
 * 
 * @invariant Errors must be caught and handled at the periphery
 */
export class ZineshError extends Error {
  public readonly code: ZineshErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: ZineshErrorCode, message: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = 'ZineshError';
    this.code = code;
    this.details = details;
    
    // Proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ZineshError);
    }
  }
}

// ============================================================================
// AGGREGATE ROOT - The Cell itself
// ============================================================================

/**
 * The Cell aggregate root.
 * Contains all state for a single escrow instance.
 * 
 * @invariant Isolation - No references to other cells
 * @invariant Immutability - Properties are readonly; mutations via events
 */
export interface Cell {
  readonly id: CellId;
  readonly state: CellState;
  readonly policy: Policy;
  readonly parties: ReadonlyArray<Party>;
  readonly fundedAmount?: Amount | undefined;
  readonly releasedAmount?: Amount | undefined;
  readonly refundedAmount?: Amount | undefined;
  readonly eventLog: ReadonlyArray<Event>;
  readonly processedCommands: ReadonlySet<string>; // For replay detection
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Result of applying a command.
 */
export interface CommandResult {
  readonly success: boolean;
  readonly newState?: Cell;
  readonly events?: ReadonlyArray<Event>;
  readonly error?: ZineshError;
}

/**
 * Projection of cell state for external queries.
 * Derived from the event log.
 */
export interface CellProjection {
  readonly id: CellId;
  readonly state: CellState;
  readonly policy: Policy;
  readonly fundedAmount?: Amount;
  readonly remainingAmount?: Amount; // funded - released - refunded
  readonly canRelease: boolean;
  readonly canRefund: boolean;
  readonly canDispute: boolean;
  readonly timeoutReached: boolean;
}
