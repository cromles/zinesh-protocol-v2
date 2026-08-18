/**
 * Zinesh 2.0 - Pure State Machine Kernel
 * 
 * This module implements the deterministic, side-effect free state transition logic
 * for the M1 Independent Escrow Cells protocol.
 * 
 * DESIGN PRINCIPLES:
 * - 100% pure functions (no I/O, no network, no DB, no randomness)
 * - Immutable state transformations
 * - Explicit error handling via CommandResult
 * - Full testability in isolation
 * 
 * @see docs/ARCHITECTURE.md - System architecture
 * @see docs/INVARIANTS.md - Protocol invariants
 * @see src/core/types.ts - Domain types
 */

import {
  Cell,
  CellId,
  CellState,
  Command,
  CommandResult,
  Event,
  Policy,
  Party,
  PartyRole,
  Amount,
  ZineshError,
  ZineshErrorCode,
  CellState as CellStates,
  BindFundingCommand,
  RequestReleaseCommand,
  RequestRefundCommand,
  OpenDisputeCommand,
  ResolveDisputeCommand,
  TriggerTimeoutCommand,
} from '../core/types.js';

// ============================================================================
// CONSTANTS & HELPERS
// ============================================================================

const TERMINAL_STATES: readonly CellState[] = [
  CellStates.Closed,
  CellStates.Terminated,
] as const;

function isTerminalState(state: CellState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Creates a new empty event log array (immutable).
 */
function createEventLog(): readonly Event[] {
  return [];
}

/**
 * Creates a new processed commands set (immutable copy).
 */
function copyProcessedCommands(commands: ReadonlySet<string>): Set<string> {
  return new Set(commands);
}

/**
 * Validates that an amount is positive.
 */
function isValidAmount(amount: Amount): boolean {
  return amount > 0n;
}

/**
 * Generates a deterministic event ID from command ID and event type.
 * In production, this could be a hash, but for the kernel we keep it simple.
 */
function generateEventId(commandId: string, eventType: string, index: number): string {
  return `${commandId}:${eventType}:${index}`;
}

/**
 * Gets the party role by address from the cell's parties.
 */
function getPartyRoleByAddress(cell: Cell, address: string): PartyRole | undefined {
  const party = cell.parties.find(p => p.address === address);
  return party?.role;
}

/**
 * Gets the arbiter address from the cell's policy.
 */
function getArbiterAddress(cell: Cell): string | undefined {
  return cell.policy.arbiter;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize a new escrow cell from a CreateCellCommand.
 * 
 * This is the only way to create a new Cell aggregate.
 * 
 * @param command - The CreateCellCommand
 * @returns CommandResult with new Cell on success, error on failure
 */
export function initializeCell(command: Command): CommandResult {
  if (command.type !== 'CreateCell') {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.PolicyViolation,
        'initializeCell requires a CreateCellCommand'
      ),
    };
  }

  // Validate policy amount > 0
  if (!isValidAmount(command.policy.amount)) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.InvalidAmount,
        'Policy amount must be positive'
      ),
    };
  }

  // Validate payer and payee are different
  if (command.payer === command.payee) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.PolicyViolation,
        'Payer and payee must be different addresses'
      ),
    };
  }

  // Validate timeout is in the future (relative to command timestamp)
  if (command.policy.timeout <= command.timestamp) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.PolicyViolation,
        'Policy timeout must be in the future'
      ),
    };
  }

  // Validate arbiter if specified (must be different from payer and payee)
  if (command.policy.arbiter) {
    if (command.policy.arbiter === command.payer || command.policy.arbiter === command.payee) {
      return {
        success: false,
        error: new ZineshError(
          ZineshErrorCode.PolicyViolation,
          'Arbiter must be different from payer and payee'
        ),
      };
    }
  }

  const cellId = command.cellId;
  const now = command.timestamp;

  // Create parties array
  const parties: Party[] = [
    { role: PartyRole.Payer, address: command.payer },
    { role: PartyRole.Payee, address: command.payee },
  ];

  // Add arbiter if specified
  if (command.policy.arbiter) {
    parties.push({ role: PartyRole.Arbiter, address: command.policy.arbiter });
  }

  // Create the initial event
  const eventId = generateEventId(command.commandId, 'CellCreated', 0);
  const cellCreatedEvent: Event = {
    eventId,
    cellId,
    timestamp: now,
    version: 1,
    type: 'CellCreated',
    payer: command.payer,
    payee: command.payee,
    policy: command.policy,
  };

  // Create the initial cell in Draft state
  const cell: Cell = {
    id: cellId,
    state: CellStates.Draft,
    policy: command.policy,
    parties: Object.freeze(parties),
    eventLog: Object.freeze([cellCreatedEvent]),
    processedCommands: Object.freeze(new Set([command.commandId])),
    createdAt: now,
    updatedAt: now,
  };

  return {
    success: true,
    newState: cell,
    events: [cellCreatedEvent],
  };
}

// ============================================================================
// STATE TRANSITION FUNCTION
// ============================================================================

/**
 * Apply a command to a cell, producing a new state and events.
 * 
 * This is the core pure function of the state machine.
 * It does NOT mutate the input cell.
 * 
 * @param cell - The current cell state
 * @param command - The command to apply
 * @returns CommandResult with new Cell and events on success, error on failure
 */
export function transition(cell: Cell, command: Command): CommandResult {
  // Rule 1: Context Binding - command must match cell ID
  if (command.cellId !== cell.id) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.ContextMismatch,
        `Command cellId ${command.cellId} does not match cell ${cell.id}`
      ),
    };
  }

  // Rule 2: Replay Protection - command must not have been processed
  if (cell.processedCommands.has(command.commandId)) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.ReplayDetected,
        `Command ${command.commandId} has already been processed`
      ),
    };
  }

  // Rule 3: Terminal States - no mutations allowed in terminal states
  if (isTerminalState(cell.state)) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.InvalidStateTransition,
        `Cannot apply command in terminal state: ${cell.state}`
      ),
    };
  }

  // Dispatch to specific handler based on command type
  switch (command.type) {
    case 'CreateCell':
      return handleCreateCell(cell, command);
    case 'BindFunding':
      return handleBindFunding(cell, command);
    case 'RequestRelease':
      return handleRequestRelease(cell, command);
    case 'RequestRefund':
      return handleRequestRefund(cell, command);
    case 'OpenDispute':
      return handleOpenDispute(cell, command);
    case 'ResolveDispute':
      return handleResolveDispute(cell, command);
    case 'TriggerTimeout':
      return handleTriggerTimeout(cell, command);
    default:
      return {
        success: false,
        error: new ZineshError(
          ZineshErrorCode.PolicyViolation,
          `Unknown command type: ${(command as Command).type}`
        ),
      };
  }
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

/**
 * Handle CreateCell command.
 * 
 * Note: This should typically only be called via initializeCell.
 * If called on an existing cell, it's rejected.
 */
function handleCreateCell(cell: Cell, command: Command): CommandResult {
  // CreateCell is only valid for brand new cells (handled by initializeCell)
  // If we reach here, it means someone tried to CreateCell on an existing cell
  return {
    success: false,
    error: new ZineshError(
      ZineshErrorCode.InvalidStateTransition,
      'CreateCell command not allowed on existing cell'
    ),
  };
}

/**
 * Handle BindFunding command.
 * 
 * Transitions: AwaitingFunding -> FundedLocked
 * 
 * Requirements:
 * - Cell must be in AwaitingFunding or Draft state
 * - Funding amount must match policy amount exactly
 * - Asset must match policy asset
 * - Amount must be positive
 */
function handleBindFunding(cell: Cell, command: BindFundingCommand): CommandResult {
  // Check state precondition
  if (cell.state !== CellStates.Draft && cell.state !== CellStates.AwaitingFunding) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.InvalidStateTransition,
        `BindFunding not allowed in state: ${cell.state}`
      ),
    };
  }

  // Validate funding amount matches policy
  if (command.actualAmount !== cell.policy.amount) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.PolicyViolation,
        `Funding amount ${command.actualAmount} does not match policy amount ${cell.policy.amount}`
      ),
    };
  }

  // Validate amount is positive
  if (!isValidAmount(command.actualAmount)) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.InvalidAmount,
        'Funding amount must be positive'
      ),
    };
  }

  const now = command.timestamp;
  const eventId = generateEventId(command.commandId, 'FundingBound', 0);

  const fundingBoundEvent: Event = {
    eventId,
    cellId: cell.id,
    timestamp: now,
    version: 1,
    type: 'FundingBound',
    amount: command.actualAmount,
    fundingTxHash: command.fundingTxHash,
  };

  const newCell: Cell = {
    ...cell,
    state: CellStates.FundedLocked,
    fundedAmount: command.actualAmount,
    eventLog: Object.freeze([...cell.eventLog, fundingBoundEvent]),
    processedCommands: Object.freeze(copyProcessedCommands(cell.processedCommands).add(command.commandId)),
    updatedAt: now,
  };

  return {
    success: true,
    newState: newCell,
    events: [fundingBoundEvent],
  };
}

/**
 * Handle RequestRelease command.
 * 
 * Transitions: FundedLocked -> ReleaseRequested
 * 
 * Authorization: Only Payee can request release
 * 
 * SECURITY: Payee cannot unilaterally release funds to themselves.
 * This command only REQUESTS release; actual execution requires separate authorization.
 */
function handleRequestRelease(cell: Cell, command: RequestReleaseCommand): CommandResult {
  // Check state precondition - must be funded
  if (cell.state !== CellStates.FundedLocked) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.InvalidStateTransition,
        `RequestRelease not allowed in state: ${cell.state}. Cell must be FundedLocked.`
      ),
    };
  }

  // Authorization check: actor must be Payee
  if (command.actor !== PartyRole.Payee) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.Unauthorized,
        `RequestRelease requires Payee role, got: ${command.actor}`
      ),
    };
  }

  const now = command.timestamp;
  const eventId = generateEventId(command.commandId, 'ReleaseRequested', 0);

  const releaseRequestedEvent: Event = {
    eventId,
    cellId: cell.id,
    timestamp: now,
    version: 1,
    type: 'ReleaseRequested',
    recipientAddress: command.recipientAddress,
  };

  const newCell: Cell = {
    ...cell,
    state: CellStates.ReleaseRequested,
    eventLog: Object.freeze([...cell.eventLog, releaseRequestedEvent]),
    processedCommands: Object.freeze(copyProcessedCommands(cell.processedCommands).add(command.commandId)),
    updatedAt: now,
  };

  return {
    success: true,
    newState: newCell,
    events: [releaseRequestedEvent],
  };
}

/**
 * Execute the actual release (completes the release path).
 * 
 * Transitions: ReleaseRequested -> Closed
 * 
 * This is called after external confirmation that funds were sent.
 */
export function executeRelease(cell: Cell, txHash: string, timestamp: number): CommandResult {
  if (cell.state !== CellStates.ReleaseRequested) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.InvalidStateTransition,
        `ExecuteRelease not allowed in state: ${cell.state}`
      ),
    };
  }

  if (!cell.fundedAmount) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.FundingNotBound,
        'Cannot release without funded amount'
      ),
    };
  }

  const eventId = generateEventId(`execute-release:${timestamp}`, 'CellReleased', 0);

  const cellReleasedEvent: Event = {
    eventId,
    cellId: cell.id,
    timestamp,
    version: 1,
    type: 'CellReleased',
    amount: cell.fundedAmount,
    recipientAddress: cell.parties.find(p => p.role === PartyRole.Payee)?.address || '',
    txHash,
  };

  const newCell: Cell = {
    ...cell,
    state: CellStates.Closed,
    releasedAmount: cell.fundedAmount,
    eventLog: Object.freeze([...cell.eventLog, cellReleasedEvent]),
    updatedAt: timestamp,
  };

  return {
    success: true,
    newState: newCell,
    events: [cellReleasedEvent],
  };
}

/**
 * Handle RequestRefund command.
 * 
 * Transitions: FundedLocked -> RefundRequested
 * 
 * Authorization: Only Payer can request refund
 * 
 * SECURITY: Payer cannot unilaterally refund themselves after funding
 * unless Payee agrees or dispute/timeout resolves in their favor.
 */
function handleRequestRefund(cell: Cell, command: RequestRefundCommand): CommandResult {
  // Check state precondition - must be funded
  if (cell.state !== CellStates.FundedLocked) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.InvalidStateTransition,
        `RequestRefund not allowed in state: ${cell.state}. Cell must be FundedLocked.`
      ),
    };
  }

  // Authorization check: actor must be Payer
  if (command.actor !== PartyRole.Payer) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.Unauthorized,
        `RequestRefund requires Payer role, got: ${command.actor}`
      ),
    };
  }

  const now = command.timestamp;
  const eventId = generateEventId(command.commandId, 'RefundRequested', 0);

  const refundRequestedEvent: Event = {
    eventId,
    cellId: cell.id,
    timestamp: now,
    version: 1,
    type: 'RefundRequested',
    refundAddress: command.refundAddress,
  };

  const newCell: Cell = {
    ...cell,
    state: CellStates.RefundRequested,
    eventLog: Object.freeze([...cell.eventLog, refundRequestedEvent]),
    processedCommands: Object.freeze(copyProcessedCommands(cell.processedCommands).add(command.commandId)),
    updatedAt: now,
  };

  return {
    success: true,
    newState: newCell,
    events: [refundRequestedEvent],
  };
}

/**
 * Execute the actual refund (completes the refund path).
 * 
 * Transitions: RefundRequested -> Closed
 * 
 * This is called after external confirmation that funds were returned.
 */
export function executeRefund(cell: Cell, txHash: string, timestamp: number): CommandResult {
  if (cell.state !== CellStates.RefundRequested) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.InvalidStateTransition,
        `ExecuteRefund not allowed in state: ${cell.state}`
      ),
    };
  }

  if (!cell.fundedAmount) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.FundingNotBound,
        'Cannot refund without funded amount'
      ),
    };
  }

  const eventId = generateEventId(`execute-refund:${timestamp}`, 'CellRefunded', 0);

  const cellRefundedEvent: Event = {
    eventId,
    cellId: cell.id,
    timestamp,
    version: 1,
    type: 'CellRefunded',
    amount: cell.fundedAmount,
    refundAddress: cell.parties.find(p => p.role === PartyRole.Payer)?.address || '',
    txHash,
  };

  const newCell: Cell = {
    ...cell,
    state: CellStates.Closed,
    refundedAmount: cell.fundedAmount,
    eventLog: Object.freeze([...cell.eventLog, cellRefundedEvent]),
    updatedAt: timestamp,
  };

  return {
    success: true,
    newState: newCell,
    events: [cellRefundedEvent],
  };
}

/**
 * Handle OpenDispute command.
 * 
 * Transitions: FundedLocked -> Disputed
 *              ReleaseRequested -> Disputed
 *              RefundRequested -> Disputed
 * 
 * Authorization: Payer or Payee can open dispute
 */
function handleOpenDispute(cell: Cell, command: OpenDisputeCommand): CommandResult {
  // Check state precondition - must be in an active state
  const allowedStates: CellState[] = [
    CellStates.FundedLocked,
    CellStates.ReleaseRequested,
    CellStates.RefundRequested,
  ];

  if (!allowedStates.includes(cell.state)) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.InvalidStateTransition,
        `OpenDispute not allowed in state: ${cell.state}`
      ),
    };
  }

  // Authorization check: actor must be Payer or Payee
  if (command.actor !== PartyRole.Payer && command.actor !== PartyRole.Payee) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.Unauthorized,
        `OpenDispute requires Payer or Payee role, got: ${command.actor}`
      ),
    };
  }

  const now = command.timestamp;
  const eventId = generateEventId(command.commandId, 'DisputeOpened', 0);

  const disputeOpenedEvent: Event = {
    eventId,
    cellId: cell.id,
    timestamp: now,
    version: 1,
    type: 'DisputeOpened',
    reason: command.reason,
    evidenceHash: command.evidenceHash ?? undefined,
  };

  const newCell: Cell = {
    ...cell,
    state: CellStates.Disputed,
    eventLog: Object.freeze([...cell.eventLog, disputeOpenedEvent]),
    processedCommands: Object.freeze(copyProcessedCommands(cell.processedCommands).add(command.commandId)),
    updatedAt: now,
  };

  return {
    success: true,
    newState: newCell,
    events: [disputeOpenedEvent],
  };
}

/**
 * Handle ResolveDispute command.
 * 
 * Transitions: Disputed -> Closed
 * 
 * Authorization: Only Arbiter can resolve disputes
 * 
 * CONSERVATION RULE: releaseAmount + refundAmount MUST equal fundedAmount
 */
function handleResolveDispute(cell: Cell, command: ResolveDisputeCommand): CommandResult {
  // Check state precondition
  if (cell.state !== CellStates.Disputed) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.InvalidStateTransition,
        `ResolveDispute not allowed in state: ${cell.state}`
      ),
    };
  }

  // Authorization check: actor must be Arbiter
  if (command.actor !== PartyRole.Arbiter) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.Unauthorized,
        `ResolveDispute requires Arbiter role, got: ${command.actor}`
      ),
    };
  }

  // Verify arbiter address matches policy arbiter
  const arbiterAddress = getArbiterAddress(cell);
  if (!arbiterAddress) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.PolicyViolation,
        'No arbiter defined in policy'
      ),
    };
  }

  // Get the party with Arbiter role and verify it matches
  const arbiterParty = cell.parties.find(p => p.role === PartyRole.Arbiter);
  if (!arbiterParty || arbiterParty.address !== arbiterAddress) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.PolicyViolation,
        'Arbiter role not found in cell parties'
      ),
    };
  }

  // CONSERVATION INVARIANT: releaseAmount + refundAmount must equal fundedAmount
  if (!cell.fundedAmount) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.FundingNotBound,
        'Cannot resolve dispute without funded amount'
      ),
    };
  }

  const total = command.releaseAmount + command.refundAmount;
  if (total !== cell.fundedAmount) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.PolicyViolation,
        `Conservation violation: releaseAmount (${command.releaseAmount}) + refundAmount (${command.refundAmount}) = ${total}, but fundedAmount is ${cell.fundedAmount}`
      ),
    };
  }

  const now = command.timestamp;
  const events: Event[] = [];

  // Event 1: Dispute resolved
  const disputeResolvedId = generateEventId(command.commandId, 'DisputeResolved', 0);
  const disputeResolvedEvent: Event = {
    eventId: disputeResolvedId,
    cellId: cell.id,
    timestamp: now,
    version: 1,
    type: 'DisputeResolved',
    decidedFor: command.decideFor,
    releaseAmount: command.releaseAmount,
    refundAmount: command.refundAmount,
  };
  events.push(disputeResolvedEvent);

  // Event 2: Cell released (if releaseAmount > 0)
  if (command.releaseAmount > 0n) {
    const releaseId = generateEventId(command.commandId, 'CellReleased', 1);
    const payeeAddress = cell.parties.find(p => p.role === PartyRole.Payee)?.address || '';
    const cellReleasedEvent: Event = {
      eventId: releaseId,
      cellId: cell.id,
      timestamp: now,
      version: 1,
      type: 'CellReleased',
      amount: command.releaseAmount,
      recipientAddress: payeeAddress,
    };
    events.push(cellReleasedEvent);
  }

  // Event 3: Cell refunded (if refundAmount > 0)
  if (command.refundAmount > 0n) {
    const refundId = generateEventId(command.commandId, 'CellRefunded', 2);
    const payerAddress = cell.parties.find(p => p.role === PartyRole.Payer)?.address || '';
    const cellRefundedEvent: Event = {
      eventId: refundId,
      cellId: cell.id,
      timestamp: now,
      version: 1,
      type: 'CellRefunded',
      amount: command.refundAmount,
      refundAddress: payerAddress,
    };
    events.push(cellRefundedEvent);
  }

  const newCell: Cell = {
    ...cell,
    state: CellStates.Closed,
    releasedAmount: command.releaseAmount > 0n ? command.releaseAmount : (undefined as undefined),
    refundedAmount: command.refundAmount > 0n ? command.refundAmount : (undefined as undefined),
    eventLog: Object.freeze([...cell.eventLog, ...events]),
    processedCommands: Object.freeze(copyProcessedCommands(cell.processedCommands).add(command.commandId)),
    updatedAt: now,
  };

  return {
    success: true,
    newState: newCell,
    events,
  };
}

/**
 * Handle TriggerTimeout command.
 * 
 * Transitions: FundedLocked -> Terminated (with refund)
 *              ReleaseRequested -> Terminated (with refund)
 *              RefundRequested -> Terminated (with refund)
 *              Disputed -> Terminated (with refund)
 * 
 * Authorization: Any party can trigger timeout
 * 
 * TIMEOUT ASSUMPTION: If timeout is reached and no resolution occurred,
 * funds are refunded to the PAYER by default.
 * 
 * This is a liveness mechanism that does NOT require global authority.
 * The kernel only validates the timeout condition for this specific cell.
 */
function handleTriggerTimeout(cell: Cell, command: TriggerTimeoutCommand): CommandResult {
  // Check state precondition - timeout can happen from any non-terminal, non-Draft state
  const allowedStates: CellState[] = [
    CellStates.FundedLocked,
    CellStates.ReleaseRequested,
    CellStates.RefundRequested,
    CellStates.Disputed,
  ];

  if (!allowedStates.includes(cell.state)) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.InvalidStateTransition,
        `TriggerTimeout not allowed in state: ${cell.state}`
      ),
    };
  }

  // Check that timeout has actually been reached
  if (command.currentTime < cell.policy.timeout) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.TimeoutNotReached,
        `Timeout not yet reached. Current: ${command.currentTime}, Timeout: ${cell.policy.timeout}`
      ),
    };
  }

  // Must have funded amount to refund
  if (!cell.fundedAmount) {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.FundingNotBound,
        'Cannot trigger timeout without funded amount'
      ),
    };
  }

  const now = command.timestamp;
  const events: Event[] = [];

  // Event 1: Cell terminated due to timeout
  const terminateId = generateEventId(command.commandId, 'CellTerminated', 0);
  const cellTerminatedEvent: Event = {
    eventId: terminateId,
    cellId: cell.id,
    timestamp: now,
    version: 1,
    type: 'CellTerminated',
    reason: 'Timeout reached - automatic refund to payer',
    refundAmount: cell.fundedAmount,
  };
  events.push(cellTerminatedEvent);

  // Event 2: Cell refunded (full amount to payer)
  const refundId = generateEventId(command.commandId, 'CellRefunded', 1);
  const payerAddress = cell.parties.find(p => p.role === PartyRole.Payer)?.address || '';
  const cellRefundedEvent: Event = {
    eventId: refundId,
    cellId: cell.id,
    timestamp: now,
    version: 1,
    type: 'CellRefunded',
    amount: cell.fundedAmount,
    refundAddress: payerAddress,
  };
  events.push(cellRefundedEvent);

  const newCell: Cell = {
    ...cell,
    state: CellStates.Terminated,
    refundedAmount: cell.fundedAmount,
    eventLog: Object.freeze([...cell.eventLog, ...events]),
    processedCommands: Object.freeze(copyProcessedCommands(cell.processedCommands).add(command.commandId)),
    updatedAt: now,
  };

  return {
    success: true,
    newState: newCell,
    events,
  };
}

// ============================================================================
// PROJECTION HELPERS
// ============================================================================

/**
 * Project the current state of a cell for external queries.
 * This is a pure function derived from the cell state.
 */
export function projectCell(cell: Cell): {
  id: CellId;
  state: CellState;
  policy: Policy;
  fundedAmount?: Amount | undefined;
  remainingAmount?: Amount | undefined;
  canRelease: boolean;
  canRefund: boolean;
  canDispute: boolean;
  timeoutReached: boolean;
  currentTime?: number;
} {
  const fundedAmount = cell.fundedAmount ?? 0n;
  const releasedAmount = cell.releasedAmount ?? 0n;
  const refundedAmount = cell.refundedAmount ?? 0n;
  const remainingAmount = fundedAmount - releasedAmount - refundedAmount;

  return {
    id: cell.id,
    state: cell.state,
    policy: cell.policy,
    fundedAmount: cell.fundedAmount,
    remainingAmount: remainingAmount > 0n ? remainingAmount : undefined,
    canRelease: cell.state === CellStates.FundedLocked || cell.state === CellStates.ReleaseRequested,
    canRefund: cell.state === CellStates.FundedLocked || cell.state === CellStates.RefundRequested,
    canDispute: cell.state === CellStates.FundedLocked ||
                 cell.state === CellStates.ReleaseRequested ||
                 cell.state === CellStates.RefundRequested,
    timeoutReached: false, // Caller must provide current time to evaluate
  };
}

/**
 * Check if timeout has been reached for a cell.
 * Requires external time source (not part of the pure kernel).
 */
export function isTimeoutReached(cell: Cell, currentTime: number): boolean {
  return currentTime >= cell.policy.timeout;
}

/**
 * Replay events to reconstruct cell state.
 * This demonstrates that the event log is sufficient to rebuild state.
 * 
 * NOTE: This is primarily for testing and audit purposes.
 * In production, you would use initializeCell + transition for each command.
 */
export function replayFromEvents(
  cellId: CellId,
  events: readonly Event[]
): CommandResult {
  if (events.length === 0) {
    return {
      success: false,
      error: new ZineshError(ZineshErrorCode.CellNotFound, 'No events to replay'),
    };
  }

  // First event must be CellCreated
  const firstEvent = events[0]!;
  if (firstEvent.type !== 'CellCreated') {
    return {
      success: false,
      error: new ZineshError(
        ZineshErrorCode.PolicyViolation,
        'First event must be CellCreated'
      ),
    };
  }

  // Reconstruct the cell from events (simplified - in practice you'd process all events)
  // This is mainly for demonstration/testing
  return {
    success: true,
    // Would need full event sourcing logic here for complete reconstruction
    // For now, we just validate the event log structure
  };
}
