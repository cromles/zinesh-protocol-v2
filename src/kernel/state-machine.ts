/**
 * ZINESH PROTOCOL V2 — Domain State Machine
 *
 * All escrow domain rules live here and ONLY here.
 *
 * This file:
 *   - is pure (no I/O, no time, no randomness, no global state)
 *   - implements all command handlers
 *   - implements the event folder (state reconstructor)
 *   - enforces all authorization rules
 *   - enforces all state transition rules
 *   - enforces all invariants (money, deadline, settlement)
 *
 * Domain rules encoded from ZINESH DOMAIN SPEC v1.0 — LOCKED.
 * No rule outside the spec is introduced here.
 */

import type {
  ActorId,
  ApproveRefundPayload,
  ApproveReleasePayload,
  CellId,
  CellState,
  Command,
  CreateCellPayload,
  DeterministicContext,
  ExpireCellPayload,
  ForceRefundPayload,
  FundCellPayload,
  KernelError,
  OpenDisputePayload,
  RequestRefundPayload,
  RequestReleasePayload,
  ResolveDisputePayload,
} from '../core/types';
import { kernelError, makeAmount, TERMINAL_STATUSES, ZERO_VERSION } from '../core/types';
import type { CommandHandler, EventEmission, EventFolder, KernelHandlers } from './kernel';
import type { Event } from '../core/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HandlerResult =
  | { readonly ok: true;  readonly emissions: ReadonlyArray<EventEmission> }
  | { readonly ok: false; readonly error: KernelError };

function ok(emissions: ReadonlyArray<EventEmission>): HandlerResult {
  return { ok: true, emissions };
}

function fail(code: KernelError['code'], message: string): HandlerResult {
  return { ok: false, error: kernelError(code, message) };
}

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

/**
 * Before any events are applied, the state has no domain fields.
 * CreateCell is always the first event; it populates everything.
 * We use a sentinel representation for the pre-creation state.
 */
function initialState(cellId: CellId): CellState {
  return {
    cellId,
    status: 'CREATED',
    // These fields will be populated by CellCreated event.
    // We use temporary sentinel values that are immediately overwritten.
    // The kernel enforces that CreateCell must be the first command.
    payer:               '' as ActorId,
    payee:               '' as ActorId,
    amount:              makeAmount(1n),   // sentinel, overwritten by CellCreated
    currency:            'TRY',
    fundingDeadline:     0 as import('../core/types').Timestamp,
    completionDeadline:  0 as import('../core/types').Timestamp,
  };
}

// ---------------------------------------------------------------------------
// Event folder (pure state reconstructor)
// ---------------------------------------------------------------------------

const eventFolder: EventFolder = (state, event): CellState => {
  switch (event.type as import('../core/types').DomainEventType) {
    case 'CellCreated': {
      const p = event.payload as import('../core/types').CellCreatedPayload;
      const created: CellState = {
        cellId:              state.cellId,
        status:              'CREATED',
        payer:               p.payer,
        payee:               p.payee,
        amount:              p.amount,
        currency:            p.currency,
        fundingDeadline:     p.fundingDeadline,
        completionDeadline:  p.completionDeadline,
      };
      if (p.arbiter !== undefined) {
        return { ...created, arbiter: p.arbiter };
      }
      return created;
    }

    case 'CellFunded': {
      const p = event.payload as import('../core/types').CellFundedPayload;
      return {
        ...state,
        status:   'FUNDED',
        fundedAt: event.timestamp,
        // Verify funded amount matches cell amount (kernel invariant — already
        // checked in FundCell handler, but fold is the source of truth for state).
        amount: p.amount,
      };
    }

    case 'ReleaseRequested': {
      const p = event.payload as import('../core/types').ReleaseRequestedPayload;
      return { ...state, releaseRequestedBy: p.requestedBy };
    }

    case 'Released': {
      return { ...state, status: 'RELEASED' };
    }

    case 'RefundRequested': {
      const p = event.payload as import('../core/types').RefundRequestedPayload;
      return { ...state, refundRequestedBy: p.requestedBy };
    }

    case 'Refunded': {
      return { ...state, status: 'REFUNDED' };
    }

    case 'CellExpired': {
      return { ...state, status: 'EXPIRED' };
    }

    case 'DisputeOpened': {
      return { ...state, status: 'DISPUTED' };
    }

    case 'DisputeResolved': {
      // DisputeResolved alone does not change status.
      // The subsequent Released or Refunded event changes status.
      return state;
    }

    default: {
      // Unknown event types are silently ignored in fold (forward-compatibility).
      return state;
    }
  }
};

// ---------------------------------------------------------------------------
// Guard: cell must not yet be initialised (for CreateCell)
// ---------------------------------------------------------------------------

function assertUninitialized(state: CellState): KernelError | null {
  // A cell is "uninitialized" when payer is empty — the sentinel value.
  if (state.payer !== ('' as ActorId)) {
    return kernelError('ILLEGAL_TRANSITION', 'Cell is already created');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Guard: cell must be in specific status
// ---------------------------------------------------------------------------

function assertStatus(
  state: CellState,
  ...allowed: import('../core/types').CellStatus[]
): KernelError | null {
  if (!allowed.includes(state.status)) {
    return kernelError(
      'ILLEGAL_TRANSITION',
      `Command not allowed in status ${state.status}; allowed: ${allowed.join(', ')}`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Guard: terminal check (also done in kernel frame, belt-and-suspenders here)
// ---------------------------------------------------------------------------

function assertNotTerminal(state: CellState): KernelError | null {
  if (TERMINAL_STATUSES.has(state.status)) {
    return kernelError('ILLEGAL_TRANSITION', `Cell is in terminal status ${state.status}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command Handlers
// ---------------------------------------------------------------------------

const handleCreateCell: CommandHandler = (state, command): HandlerResult => {
  const guard = assertUninitialized(state);
  if (guard !== null) return { ok: false, error: guard };

  const p = command.payload as CreateCellPayload;

  if (p.amount <= 0n) {
    return fail('INVARIANT_VIOLATION', 'Amount must be positive');
  }
  if (p.currency !== 'TRY') {
    return fail('INVARIANT_VIOLATION', 'Only TRY currency is supported');
  }
  if (p.fundingDeadline >= p.completionDeadline) {
    return fail('INVARIANT_VIOLATION', 'fundingDeadline must be before completionDeadline');
  }
  if (p.payer === p.payee) {
    return fail('INVARIANT_VIOLATION', 'payer and payee must be different actors');
  }
  if (p.arbiter !== undefined && (p.arbiter === p.payer || p.arbiter === p.payee)) {
    return fail('INVARIANT_VIOLATION', 'arbiter must be different from payer and payee');
  }

  return ok([{
    eventType: 'CellCreated',
    payload: {
      payer:               p.payer,
      payee:               p.payee,
      arbiter:             p.arbiter,
      amount:              p.amount,
      currency:            p.currency,
      fundingDeadline:     p.fundingDeadline,
      completionDeadline:  p.completionDeadline,
    },
  }]);
};

const handleFundCell: CommandHandler = (state, command): HandlerResult => {
  const guard = assertStatus(state, 'CREATED');
  if (guard !== null) return { ok: false, error: guard };

  const p = command.payload as FundCellPayload;

  // Authorization: funderId must be the cell's payer.
  // Gateway authorization is an infrastructure concern outside the kernel.
  if (p.funderId !== state.payer) {
    return fail(
      'AUTHORIZATION_DENIED',
      `FundCell funderId must be payer (${state.payer}), got ${p.funderId}`,
    );
  }

  // Exact amount check — no partial funding
  if (p.amount !== state.amount) {
    return fail(
      'INVARIANT_VIOLATION',
      `FundCell amount ${p.amount} does not match cell amount ${state.amount}`,
    );
  }

  return ok([{
    eventType: 'CellFunded',
    payload: { fundedBy: p.funderId, amount: p.amount },
  }]);
};

const handleRequestRelease: CommandHandler = (state, command): HandlerResult => {
  const guard = assertStatus(state, 'FUNDED');
  if (guard !== null) return { ok: false, error: guard };

  const p = command.payload as RequestReleasePayload;
  const actor = p.requestedBy;

  // Authorization: Payer OR Payee
  if (actor !== state.payer && actor !== state.payee) {
    return fail('AUTHORIZATION_DENIED', 'Only Payer or Payee may request release');
  }

  // Idempotency: reject if a release request is already pending
  if (state.releaseRequestedBy !== undefined) {
    return fail('PRECONDITION_FAILED', 'A release request is already pending');
  }

  // Audit event only — no state transition
  return ok([{
    eventType: 'ReleaseRequested',
    payload: { requestedBy: actor },
  }]);
};

const handleApproveRelease: CommandHandler = (state, command): HandlerResult => {
  const guard = assertStatus(state, 'FUNDED');
  if (guard !== null) return { ok: false, error: guard };

  const p = command.payload as ApproveReleasePayload;
  const actor = p.approvedBy;

  // Authorization: must be the OTHER party than the requester
  if (state.releaseRequestedBy === undefined) {
    return fail('PRECONDITION_FAILED', 'No release has been requested yet');
  }

  const requester = state.releaseRequestedBy;
  let expectedApprover: ActorId;
  if (requester === state.payer) {
    expectedApprover = state.payee;
  } else if (requester === state.payee) {
    expectedApprover = state.payer;
  } else {
    return fail('INVARIANT_VIOLATION', 'Release was requested by an unknown actor');
  }

  if (actor !== expectedApprover) {
    return fail(
      'AUTHORIZATION_DENIED',
      `ApproveRelease must be performed by ${expectedApprover}, not ${actor}`,
    );
  }

  return ok([{
    eventType: 'Released',
    payload: { approvedBy: actor },
  }]);
};

const handleRequestRefund: CommandHandler = (state, command): HandlerResult => {
  const guard = assertStatus(state, 'FUNDED');
  if (guard !== null) return { ok: false, error: guard };

  const p = command.payload as RequestRefundPayload;
  const actor = p.requestedBy;

  // Authorization: Payer only
  if (actor !== state.payer) {
    return fail('AUTHORIZATION_DENIED', 'Only Payer may request refund');
  }

  // Idempotency: reject if a refund request is already pending
  if (state.refundRequestedBy !== undefined) {
    return fail('PRECONDITION_FAILED', 'A refund request is already pending');
  }

  return ok([{
    eventType: 'RefundRequested',
    payload: { requestedBy: actor },
  }]);
};

const handleApproveRefund: CommandHandler = (state, command): HandlerResult => {
  const guard = assertStatus(state, 'FUNDED');
  if (guard !== null) return { ok: false, error: guard };

  const p = command.payload as ApproveRefundPayload;
  const actor = p.approvedBy;

  // Authorization: Payee only
  if (actor !== state.payee) {
    return fail('AUTHORIZATION_DENIED', 'Only Payee may approve refund');
  }

  if (state.refundRequestedBy === undefined) {
    return fail('PRECONDITION_FAILED', 'No refund has been requested yet');
  }

  return ok([{
    eventType: 'Refunded',
    payload: { approvedBy: actor },
  }]);
};

const handleForceRefund: CommandHandler = (state, command): HandlerResult => {
  const guard = assertStatus(state, 'FUNDED');
  if (guard !== null) return { ok: false, error: guard };

  const p = command.payload as ForceRefundPayload;
  const actor = p.requestedBy;

  // Authorization: Payer only
  if (actor !== state.payer) {
    return fail('AUTHORIZATION_DENIED', 'Only Payer may force refund');
  }

  // Deadline check: currentTime > completionDeadline
  if (p.currentTime <= state.completionDeadline) {
    return fail(
      'DEADLINE_VIOLATION',
      `ForceRefund requires currentTime > completionDeadline. ` +
      `currentTime=${p.currentTime}, completionDeadline=${state.completionDeadline}`,
    );
  }

  return ok([{
    eventType: 'Refunded',
    payload: { approvedBy: actor },
  }]);
};

const handleExpireCell: CommandHandler = (state, command): HandlerResult => {
  const guard = assertStatus(state, 'CREATED');
  if (guard !== null) return { ok: false, error: guard };

  const p = command.payload as ExpireCellPayload;

  // Deadline check: currentTime > fundingDeadline
  if (p.currentTime <= state.fundingDeadline) {
    return fail(
      'DEADLINE_VIOLATION',
      `ExpireCell requires currentTime > fundingDeadline. ` +
      `currentTime=${p.currentTime}, fundingDeadline=${state.fundingDeadline}`,
    );
  }

  return ok([{
    eventType: 'CellExpired',
    payload: { triggeredBy: p.triggeredBy, currentTime: p.currentTime },
  }]);
};

const handleOpenDispute: CommandHandler = (state, command): HandlerResult => {
  const guard = assertStatus(state, 'FUNDED');
  if (guard !== null) return { ok: false, error: guard };

  const p = command.payload as OpenDisputePayload;
  const actor = p.openedBy;

  // Authorization: Payer OR Payee
  if (actor !== state.payer && actor !== state.payee) {
    return fail('AUTHORIZATION_DENIED', 'Only Payer or Payee may open a dispute');
  }

  // Arbiter must exist
  if (state.arbiter === undefined) {
    return fail('PRECONDITION_FAILED', 'Cannot open dispute: no arbiter is defined for this cell');
  }

  // currentTime < completionDeadline
  if (p.currentTime >= state.completionDeadline) {
    return fail(
      'DEADLINE_VIOLATION',
      `OpenDispute requires currentTime < completionDeadline. ` +
      `currentTime=${p.currentTime}, completionDeadline=${state.completionDeadline}`,
    );
  }

  return ok([{
    eventType: 'DisputeOpened',
    payload: { openedBy: actor, currentTime: p.currentTime },
  }]);
};

const handleResolveDispute: CommandHandler = (state, command): HandlerResult => {
  const guard = assertStatus(state, 'DISPUTED');
  if (guard !== null) return { ok: false, error: guard };

  const p = command.payload as ResolveDisputePayload;
  const actor = p.resolvedBy;

  // Authorization: Arbiter only
  if (state.arbiter === undefined || actor !== state.arbiter) {
    return fail('AUTHORIZATION_DENIED', 'Only the Arbiter may resolve a dispute');
  }

  // Resolution is binary
  const settlementEventType = p.favourOf === 'payee' ? 'Released' : 'Refunded';
  const settlementPayload =
    p.favourOf === 'payee'
      ? { approvedBy: actor }
      : { approvedBy: actor };

  // ResolveDispute MUST produce DisputeResolved THEN Released/Refunded
  return ok([
    {
      eventType: 'DisputeResolved',
      payload: { resolvedBy: actor, favourOf: p.favourOf },
    },
    {
      eventType: settlementEventType,
      payload:   settlementPayload,
    },
  ]);
};

// ---------------------------------------------------------------------------
// Assembled KernelHandlers
// ---------------------------------------------------------------------------

export const cellKernelHandlers: KernelHandlers = {
  initialState,
  eventFolder,
  commandHandlers: {
    CreateCell:      handleCreateCell,
    FundCell:        handleFundCell,
    RequestRelease:  handleRequestRelease,
    ApproveRelease:  handleApproveRelease,
    RequestRefund:   handleRequestRefund,
    ApproveRefund:   handleApproveRefund,
    ForceRefund:     handleForceRefund,
    ExpireCell:      handleExpireCell,
    OpenDispute:     handleOpenDispute,
    ResolveDispute:  handleResolveDispute,
  },
};

// ---------------------------------------------------------------------------
// Public factory — create a Kernel bound to the cell domain
// ---------------------------------------------------------------------------

export { createKernel } from './kernel';

import { createKernel } from './kernel';

/**
 * The ready-to-use Zinesh escrow kernel.
 * Import this instance rather than calling createKernel yourself.
 */
export const cellKernel = createKernel(cellKernelHandlers);
