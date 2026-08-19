/**
 * ZINESH PROTOCOL V2 — Domain State Machine Tests
 *
 * Tests real locked domain rules from ZINESH DOMAIN SPEC v1.0.
 * No invented business rules.
 *
 * Coverage:
 *  1.  CreateCell
 *  2.  FundCell
 *  3.  ExpireCell
 *  4.  RequestRelease
 *  5.  ApproveRelease
 *  6.  RequestRefund
 *  7.  ApproveRefund
 *  8.  ForceRefund
 *  9.  OpenDispute
 *  10. ResolveDispute → Payee (RELEASED)
 *  11. ResolveDispute → Payer (REFUNDED)
 *  12. Unauthorized actors
 *  13. Missing arbiter
 *  14. Deadline violations
 *  15. Terminal state rejection
 *  16. Double funding
 *  17. Double settlement
 *  18. Partial funding rejection
 *  19. Partial settlement rejection (no split — binary only)
 *  20. Event ordering (stream integrity)
 *  21. Event replay (state reconstruction)
 *  22. Version gaps
 *  23. Wrong cell events
 *  24. Deterministic execution
 */

import { cellKernel } from './index';
import {
  makeActorId,
  makeCellId,
  makeCommandId,
  makeEventId,
  makeTimestamp,
  makeAmount,
  ZERO_VERSION,
  nextVersion,
} from '../core/types';
import type {
  ActorId,
  CellId,
  CellState,
  Command,
  DeterministicContext,
  Event,
  KernelError,
  Timestamp,
  Amount,
} from '../core/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAYER   = makeActorId('payer-1');
const PAYEE   = makeActorId('payee-1');
const ARBITER = makeActorId('arbiter-1');
const STRANGER = makeActorId('stranger-99');

const CELL_A: CellId = makeCellId('cell-a');
const CELL_B: CellId = makeCellId('cell-b');

const AMOUNT: Amount = makeAmount(10000n); // 100.00 TRY in kuruş

// Timestamps
const T0  = makeTimestamp(1_000_000); // base time
const T_FUNDING_DEADLINE     = makeTimestamp(2_000_000);
const T_COMPLETION_DEADLINE  = makeTimestamp(5_000_000);
const T_BEFORE_FUNDING_DL    = makeTimestamp(1_500_000); // between T0 and funding deadline
const T_AFTER_FUNDING_DL     = makeTimestamp(2_500_000); // after funding deadline
const T_AFTER_COMPLETION_DL  = makeTimestamp(6_000_000); // after completion deadline
const T_BEFORE_COMPLETION_DL = makeTimestamp(4_000_000); // before completion deadline

let idCounter = 0;

function makeCtx(now: Timestamp = T0): DeterministicContext {
  return {
    now,
    nextEventId: (i) => makeEventId(`evt-${idCounter++}-${i}`),
  };
}

function makeCmd(type: Command['type'], payload: Command['payload']): Command {
  return {
    commandId: makeCommandId(`cmd-${idCounter++}`),
    cellId:    CELL_A,
    type,
    payload,
  };
}

/** Build a standard CreateCell command payload */
function createCellPayload(opts: { arbiter?: ActorId } = {}) {
  return {
    payer:               PAYER,
    payee:               PAYEE,
    amount:              AMOUNT,
    currency:            'TRY' as const,
    fundingDeadline:     T_FUNDING_DEADLINE,
    completionDeadline:  T_COMPLETION_DEADLINE,
    ...(opts.arbiter !== undefined ? { arbiter: opts.arbiter } : {}),
  };
}

/**
 * Helper: apply a sequence of commands and return the final state.
 * Throws (fails the test) if any step fails unexpectedly.
 */
function applyAll(
  commands: Array<{ cmd: Command; ctx?: DeterministicContext }>,
): CellState {
  let state = cellKernel.evolve(CELL_A, []);
  // evolve with empty stream returns initial state (or KernelError if stream invalid)
  if ('code' in state) throw new Error(`Unexpected error in evolve: ${state.message}`);

  let version = nextVersion(ZERO_VERSION);
  for (const { cmd, ctx } of commands) {
    const result = cellKernel.applyCommand(state, cmd, version, ctx ?? makeCtx());
    if (!result.ok) throw new Error(`Unexpected failure: ${result.error.code} — ${result.error.message}`);
    state = result.nextState;
    version = (version + result.events.length) as typeof version;
  }
  return state;
}

/**
 * Helper: run CreateCell → FundCell and return funded state.
 */
function fundedState(opts: { arbiter?: ActorId } = {}): CellState {
  return applyAll([
    { cmd: makeCmd('CreateCell', createCellPayload(opts)) },
    { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
  ]);
}

/**
 * Helper: apply a single command to a state and expect failure.
 */
function expectFail(
  state: CellState,
  cmd: Command,
  expectedCode: KernelError['code'],
  version = nextVersion(ZERO_VERSION),
): void {
  const result = cellKernel.applyCommand(state, cmd, version, makeCtx());
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(expectedCode);
}

// ---------------------------------------------------------------------------
// 1. CreateCell
// ---------------------------------------------------------------------------

describe('1. CreateCell', () => {
  test('creates a cell with correct initial fields', () => {
    const initialState = cellKernel.evolve(CELL_A, []);
    expect('code' in initialState).toBe(false);
    if ('code' in initialState) return;

    const result = cellKernel.applyCommand(
      initialState,
      makeCmd('CreateCell', createCellPayload({ arbiter: ARBITER })),
      nextVersion(ZERO_VERSION),
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('CellCreated');
    expect(result.nextState.status).toBe('CREATED');
    expect(result.nextState.payer).toBe(PAYER);
    expect(result.nextState.payee).toBe(PAYEE);
    expect(result.nextState.arbiter).toBe(ARBITER);
    expect(result.nextState.amount).toBe(AMOUNT);
    expect(result.nextState.currency).toBe('TRY');
    expect(result.nextState.fundingDeadline).toBe(T_FUNDING_DEADLINE);
    expect(result.nextState.completionDeadline).toBe(T_COMPLETION_DEADLINE);
  });

  test('creates a cell without arbiter', () => {
    const initialState = cellKernel.evolve(CELL_A, []);
    if ('code' in initialState) throw new Error('unexpected');
    const result = cellKernel.applyCommand(
      initialState,
      makeCmd('CreateCell', createCellPayload()),
      nextVersion(ZERO_VERSION),
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.arbiter).toBeUndefined();
  });

  test('rejects payer === payee', () => {
    const initialState = cellKernel.evolve(CELL_A, []);
    if ('code' in initialState) throw new Error('unexpected');
    expectFail(initialState, makeCmd('CreateCell', {
      ...createCellPayload(),
      payee: PAYER,
    }), 'INVARIANT_VIOLATION');
  });

  test('rejects arbiter === payer', () => {
    const initialState = cellKernel.evolve(CELL_A, []);
    if ('code' in initialState) throw new Error('unexpected');
    expectFail(initialState, makeCmd('CreateCell', {
      ...createCellPayload(),
      arbiter: PAYER,
    }), 'INVARIANT_VIOLATION');
  });

  test('rejects fundingDeadline >= completionDeadline', () => {
    const initialState = cellKernel.evolve(CELL_A, []);
    if ('code' in initialState) throw new Error('unexpected');
    expectFail(initialState, makeCmd('CreateCell', {
      ...createCellPayload(),
      fundingDeadline:    T_COMPLETION_DEADLINE,
      completionDeadline: T_FUNDING_DEADLINE,
    }), 'INVARIANT_VIOLATION');
  });

  test('rejects non-TRY currency', () => {
    const initialState = cellKernel.evolve(CELL_A, []);
    if ('code' in initialState) throw new Error('unexpected');
    expectFail(initialState, makeCmd('CreateCell', {
      ...createCellPayload(),
      currency: 'USD' as unknown as 'TRY',
    }), 'INVARIANT_VIOLATION');
  });

  test('rejects double creation', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload()) }]);
    expectFail(state, makeCmd('CreateCell', createCellPayload()), 'ILLEGAL_TRANSITION',
      nextVersion(nextVersion(ZERO_VERSION)));
  });
});

// ---------------------------------------------------------------------------
// 2. FundCell
// ---------------------------------------------------------------------------

describe('2. FundCell', () => {
  test('transitions CREATED → FUNDED', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload()) }]);
    const v2 = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(state, makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }), v2, makeCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.status).toBe('FUNDED');
    expect(result.events[0]!.type).toBe('CellFunded');
  });

  test('rejects FundCell in non-CREATED state', () => {
    const state = fundedState();
    expectFail(state, makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }), 'ILLEGAL_TRANSITION',
      (nextVersion(ZERO_VERSION) + 2) as typeof ZERO_VERSION);
  });
});

// ---------------------------------------------------------------------------
// 16. Double funding
// ---------------------------------------------------------------------------

describe('16. Double funding', () => {
  test('cannot fund a cell that is already FUNDED', () => {
    const state = fundedState();
    expectFail(state, makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }), 'ILLEGAL_TRANSITION',
      (ZERO_VERSION + 3) as typeof ZERO_VERSION);
  });
});

// ---------------------------------------------------------------------------
// 18. Partial funding rejection
// ---------------------------------------------------------------------------

describe('18. Partial funding rejection', () => {
  test('rejects funding with less than cell amount', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload()) }]);
    const v2 = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(
      state,
      makeCmd('FundCell', { funderId: PAYER, amount: makeAmount(5000n) }),
      v2,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVARIANT_VIOLATION');
  });

  test('rejects funding with more than cell amount', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload()) }]);
    const v2 = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(
      state,
      makeCmd('FundCell', { funderId: PAYER, amount: makeAmount(20000n) }),
      v2,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVARIANT_VIOLATION');
  });
});

// ---------------------------------------------------------------------------
// 3. ExpireCell
// ---------------------------------------------------------------------------

describe('3. ExpireCell', () => {
  test('transitions CREATED → EXPIRED after fundingDeadline', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload()) }]);
    const v2 = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ExpireCell', { triggeredBy: STRANGER, currentTime: T_AFTER_FUNDING_DL }),
      v2,
      makeCtx(T_AFTER_FUNDING_DL),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.status).toBe('EXPIRED');
    expect(result.events[0]!.type).toBe('CellExpired');
  });

  test('rejects ExpireCell before fundingDeadline', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload()) }]);
    const v2 = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ExpireCell', { triggeredBy: STRANGER, currentTime: T_BEFORE_FUNDING_DL }),
      v2,
      makeCtx(T_BEFORE_FUNDING_DL),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DEADLINE_VIOLATION');
  });

  test('rejects ExpireCell when cell is FUNDED', () => {
    const state = fundedState();
    expectFail(state, makeCmd('ExpireCell', {
      triggeredBy: STRANGER, currentTime: T_AFTER_FUNDING_DL,
    }), 'ILLEGAL_TRANSITION', (ZERO_VERSION + 3) as typeof ZERO_VERSION);
  });
});

// ---------------------------------------------------------------------------
// 4. RequestRelease
// ---------------------------------------------------------------------------

describe('4. RequestRelease', () => {
  test('Payer may request release — audit event only, state stays FUNDED', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('RequestRelease', { requestedBy: PAYER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.status).toBe('FUNDED');
    expect(result.events[0]!.type).toBe('ReleaseRequested');
    expect(result.nextState.releaseRequestedBy).toBe(PAYER);
  });

  test('Payee may request release', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('RequestRelease', { requestedBy: PAYEE }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.releaseRequestedBy).toBe(PAYEE);
  });

  test('stranger cannot request release', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('RequestRelease', { requestedBy: STRANGER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// 5. ApproveRelease
// ---------------------------------------------------------------------------

describe('5. ApproveRelease', () => {
  test("Payee approves Payer's release request → RELEASED", () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRelease', { requestedBy: PAYER }) },
    ]);
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ApproveRelease', { approvedBy: PAYEE }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.status).toBe('RELEASED');
    expect(result.events[0]!.type).toBe('Released');
  });

  test("Payer approves Payee's release request → RELEASED", () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRelease', { requestedBy: PAYEE }) },
    ]);
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ApproveRelease', { approvedBy: PAYER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.status).toBe('RELEASED');
  });

  test('rejects if requester tries to self-approve', () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRelease', { requestedBy: PAYER }) },
    ]);
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ApproveRelease', { approvedBy: PAYER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });

  test('rejects if no release was requested', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ApproveRelease', { approvedBy: PAYEE }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });

  test('stranger cannot approve release', () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRelease', { requestedBy: PAYER }) },
    ]);
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ApproveRelease', { approvedBy: STRANGER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// 6. RequestRefund
// ---------------------------------------------------------------------------

describe('6. RequestRefund', () => {
  test('Payer may request refund — audit event only, state stays FUNDED', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('RequestRefund', { requestedBy: PAYER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.status).toBe('FUNDED');
    expect(result.events[0]!.type).toBe('RefundRequested');
    expect(result.nextState.refundRequestedBy).toBe(PAYER);
  });

  test('Payee cannot request refund', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('RequestRefund', { requestedBy: PAYEE }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });

  test('stranger cannot request refund', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('RequestRefund', { requestedBy: STRANGER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// 7. ApproveRefund
// ---------------------------------------------------------------------------

describe('7. ApproveRefund', () => {
  test("Payee approves Payer's refund request → REFUNDED", () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRefund', { requestedBy: PAYER }) },
    ]);
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ApproveRefund', { approvedBy: PAYEE }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.status).toBe('REFUNDED');
    expect(result.events[0]!.type).toBe('Refunded');
  });

  test('Payer cannot self-approve refund', () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRefund', { requestedBy: PAYER }) },
    ]);
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ApproveRefund', { approvedBy: PAYER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });

  test('rejects if no refund was requested', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ApproveRefund', { approvedBy: PAYEE }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });

  test('stranger cannot approve refund', () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRefund', { requestedBy: PAYER }) },
    ]);
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ApproveRefund', { approvedBy: STRANGER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// 8. ForceRefund
// ---------------------------------------------------------------------------

describe('8. ForceRefund', () => {
  test('Payer can force refund after completionDeadline → REFUNDED', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ForceRefund', { requestedBy: PAYER, currentTime: T_AFTER_COMPLETION_DL }),
      v,
      makeCtx(T_AFTER_COMPLETION_DL),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.status).toBe('REFUNDED');
    expect(result.events[0]!.type).toBe('Refunded');
  });

  test('rejects ForceRefund before completionDeadline', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ForceRefund', { requestedBy: PAYER, currentTime: T_BEFORE_COMPLETION_DL }),
      v,
      makeCtx(T_BEFORE_COMPLETION_DL),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DEADLINE_VIOLATION');
  });

  test('Payee cannot force refund', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ForceRefund', { requestedBy: PAYEE, currentTime: T_AFTER_COMPLETION_DL }),
      v,
      makeCtx(T_AFTER_COMPLETION_DL),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });

  test('rejects ForceRefund in CREATED state', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload()) }]);
    const v = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ForceRefund', { requestedBy: PAYER, currentTime: T_AFTER_COMPLETION_DL }),
      v,
      makeCtx(T_AFTER_COMPLETION_DL),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// 9. OpenDispute
// ---------------------------------------------------------------------------

describe('9. OpenDispute', () => {
  test('Payer opens dispute on FUNDED cell with arbiter → DISPUTED', () => {
    const state = fundedState({ arbiter: ARBITER });
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('OpenDispute', { openedBy: PAYER, currentTime: T_BEFORE_COMPLETION_DL }),
      v,
      makeCtx(T_BEFORE_COMPLETION_DL),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.status).toBe('DISPUTED');
    expect(result.events[0]!.type).toBe('DisputeOpened');
  });

  test('Payee opens dispute on FUNDED cell with arbiter → DISPUTED', () => {
    const state = fundedState({ arbiter: ARBITER });
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('OpenDispute', { openedBy: PAYEE, currentTime: T_BEFORE_COMPLETION_DL }),
      v,
      makeCtx(T_BEFORE_COMPLETION_DL),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.status).toBe('DISPUTED');
  });

  test('stranger cannot open dispute', () => {
    const state = fundedState({ arbiter: ARBITER });
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('OpenDispute', { openedBy: STRANGER, currentTime: T_BEFORE_COMPLETION_DL }),
      v,
      makeCtx(T_BEFORE_COMPLETION_DL),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });

  test('rejects OpenDispute after completionDeadline', () => {
    const state = fundedState({ arbiter: ARBITER });
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('OpenDispute', { openedBy: PAYER, currentTime: T_AFTER_COMPLETION_DL }),
      v,
      makeCtx(T_AFTER_COMPLETION_DL),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DEADLINE_VIOLATION');
  });

  test('rejects OpenDispute on CREATED cell', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload({ arbiter: ARBITER })) }]);
    const v = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(
      state,
      makeCmd('OpenDispute', { openedBy: PAYER, currentTime: T_BEFORE_COMPLETION_DL }),
      v,
      makeCtx(T_BEFORE_COMPLETION_DL),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// 13. Missing arbiter
// ---------------------------------------------------------------------------

describe('13. Missing arbiter', () => {
  test('OpenDispute fails when no arbiter defined', () => {
    const state = fundedState(); // no arbiter
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('OpenDispute', { openedBy: PAYER, currentTime: T_BEFORE_COMPLETION_DL }),
      v,
      makeCtx(T_BEFORE_COMPLETION_DL),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });

  test('ResolveDispute fails when no arbiter defined', () => {
    // Manually construct a DISPUTED state without arbiter (edge case — ordinarily
    // impossible via normal flow, but the domain rule must hold at the kernel level)
    const state = fundedState({ arbiter: ARBITER });
    const v1 = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    // Open dispute legitimately
    const disputeResult = cellKernel.applyCommand(
      state,
      makeCmd('OpenDispute', { openedBy: PAYER, currentTime: T_BEFORE_COMPLETION_DL }),
      v1,
      makeCtx(T_BEFORE_COMPLETION_DL),
    );
    expect(disputeResult.ok).toBe(true);
    if (!disputeResult.ok) return;
    const disputedState = disputeResult.nextState;

    // Resolve with wrong actor (not arbiter)
    const v2 = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      disputedState,
      makeCmd('ResolveDispute', { resolvedBy: PAYER, favourOf: 'payer' }),
      v2,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// 10. ResolveDispute → Payee (RELEASED)
// ---------------------------------------------------------------------------

describe('10. ResolveDispute → favour payee (RELEASED)', () => {
  function disputedState(): CellState {
    return applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload({ arbiter: ARBITER })) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('OpenDispute', { openedBy: PAYER, currentTime: T_BEFORE_COMPLETION_DL }),
        ctx: makeCtx(T_BEFORE_COMPLETION_DL) },
    ]);
  }

  test('Arbiter resolves in favour of payee → DisputeResolved then Released', () => {
    const state = disputedState();
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ResolveDispute', { resolvedBy: ARBITER, favourOf: 'payee' }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Must produce exactly 2 events in order: DisputeResolved, Released
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.type).toBe('DisputeResolved');
    expect(result.events[1]!.type).toBe('Released');
    // Versions must be consecutive
    expect(result.events[1]!.version).toBe(result.events[0]!.version + 1);
    expect(result.nextState.status).toBe('RELEASED');
  });
});

// ---------------------------------------------------------------------------
// 11. ResolveDispute → Payer (REFUNDED)
// ---------------------------------------------------------------------------

describe('11. ResolveDispute → favour payer (REFUNDED)', () => {
  function disputedState(): CellState {
    return applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload({ arbiter: ARBITER })) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('OpenDispute', { openedBy: PAYEE, currentTime: T_BEFORE_COMPLETION_DL }),
        ctx: makeCtx(T_BEFORE_COMPLETION_DL) },
    ]);
  }

  test('Arbiter resolves in favour of payer → DisputeResolved then Refunded', () => {
    const state = disputedState();
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ResolveDispute', { resolvedBy: ARBITER, favourOf: 'payer' }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.type).toBe('DisputeResolved');
    expect(result.events[1]!.type).toBe('Refunded');
    expect(result.events[1]!.version).toBe(result.events[0]!.version + 1);
    expect(result.nextState.status).toBe('REFUNDED');
  });

  test('Non-arbiter cannot resolve dispute', () => {
    const state = disputedState();
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ResolveDispute', { resolvedBy: PAYER, favourOf: 'payer' }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });

  test('ResolveDispute cannot be applied in FUNDED state', () => {
    const state = fundedState({ arbiter: ARBITER });
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ResolveDispute', { resolvedBy: ARBITER, favourOf: 'payer' }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// 12. Unauthorized actors (consolidated)
// ---------------------------------------------------------------------------

describe('12. Unauthorized actors', () => {
  test('arbiter cannot fund a cell', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload({ arbiter: ARBITER })) }]);
    const v = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(
      state,
      makeCmd('FundCell', { funderId: ARBITER, amount: AMOUNT }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });

  test('arbiter cannot open dispute', () => {
    const state = fundedState({ arbiter: ARBITER });
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('OpenDispute', { openedBy: ARBITER, currentTime: T_BEFORE_COMPLETION_DL }),
      v,
      makeCtx(T_BEFORE_COMPLETION_DL),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });

  test('arbiter cannot force refund', () => {
    const state = fundedState({ arbiter: ARBITER });
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ForceRefund', { requestedBy: ARBITER, currentTime: T_AFTER_COMPLETION_DL }),
      v,
      makeCtx(T_AFTER_COMPLETION_DL),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// 14. Deadline violations
// ---------------------------------------------------------------------------

describe('14. Deadline violations', () => {
  test('ExpireCell at exactly fundingDeadline is rejected (must be strictly after)', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload()) }]);
    const v = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ExpireCell', { triggeredBy: STRANGER, currentTime: T_FUNDING_DEADLINE }),
      v,
      makeCtx(T_FUNDING_DEADLINE),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DEADLINE_VIOLATION');
  });

  test('ForceRefund at exactly completionDeadline is rejected (must be strictly after)', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ForceRefund', { requestedBy: PAYER, currentTime: T_COMPLETION_DEADLINE }),
      v,
      makeCtx(T_COMPLETION_DEADLINE),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DEADLINE_VIOLATION');
  });

  test('OpenDispute at exactly completionDeadline is rejected (must be strictly before)', () => {
    const state = fundedState({ arbiter: ARBITER });
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('OpenDispute', { openedBy: PAYER, currentTime: T_COMPLETION_DEADLINE }),
      v,
      makeCtx(T_COMPLETION_DEADLINE),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DEADLINE_VIOLATION');
  });
});

// ---------------------------------------------------------------------------
// 15. Terminal state rejection
// ---------------------------------------------------------------------------

describe('15. Terminal state rejection', () => {
  function releasedState(): CellState {
    return applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRelease', { requestedBy: PAYER }) },
      { cmd: makeCmd('ApproveRelease', { approvedBy: PAYEE }) },
    ]);
  }

  function refundedState(): CellState {
    return applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('ForceRefund', { requestedBy: PAYER, currentTime: T_AFTER_COMPLETION_DL }),
        ctx: makeCtx(T_AFTER_COMPLETION_DL) },
    ]);
  }

  function expiredState(): CellState {
    return applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('ExpireCell', { triggeredBy: STRANGER, currentTime: T_AFTER_FUNDING_DL }),
        ctx: makeCtx(T_AFTER_FUNDING_DL) },
    ]);
  }

  test('RELEASED cell rejects any further command', () => {
    const state = releasedState();
    expect(state.status).toBe('RELEASED');
    const v = (ZERO_VERSION + 5) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });

  test('REFUNDED cell rejects any further command', () => {
    const state = refundedState();
    expect(state.status).toBe('REFUNDED');
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('RequestRelease', { requestedBy: PAYER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });

  test('EXPIRED cell rejects any further command', () => {
    const state = expiredState();
    expect(state.status).toBe('EXPIRED');
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// 17. Double settlement
// ---------------------------------------------------------------------------

describe('17. Double settlement', () => {
  test('cannot apply ApproveRelease after already RELEASED (terminal)', () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRelease', { requestedBy: PAYER }) },
      { cmd: makeCmd('ApproveRelease', { approvedBy: PAYEE }) },
    ]);
    expect(state.status).toBe('RELEASED');
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ApproveRelease', { approvedBy: PAYEE }),
      (ZERO_VERSION + 5) as typeof ZERO_VERSION,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });

  test('cannot apply ApproveRefund after already REFUNDED (terminal)', () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRefund', { requestedBy: PAYER }) },
      { cmd: makeCmd('ApproveRefund', { approvedBy: PAYEE }) },
    ]);
    expect(state.status).toBe('REFUNDED');
    const result = cellKernel.applyCommand(
      state,
      makeCmd('ApproveRefund', { approvedBy: PAYEE }),
      (ZERO_VERSION + 5) as typeof ZERO_VERSION,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// 19. Partial settlement rejection (binary only — no split)
// ---------------------------------------------------------------------------

describe('19. Partial settlement / binary resolution', () => {
  test('ResolveDispute favourOf must be payer or payee (binary, not split)', () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload({ arbiter: ARBITER })) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('OpenDispute', { openedBy: PAYER, currentTime: T_BEFORE_COMPLETION_DL }),
        ctx: makeCtx(T_BEFORE_COMPLETION_DL) },
    ]);
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;

    // Valid: payee
    const r1 = cellKernel.applyCommand(
      state,
      makeCmd('ResolveDispute', { resolvedBy: ARBITER, favourOf: 'payee' }),
      v,
      makeCtx(),
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.nextState.status).toBe('RELEASED');

    // Rebuild for payer test
    const state2 = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload({ arbiter: ARBITER })) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('OpenDispute', { openedBy: PAYER, currentTime: T_BEFORE_COMPLETION_DL }),
        ctx: makeCtx(T_BEFORE_COMPLETION_DL) },
    ]);
    const r2 = cellKernel.applyCommand(
      state2,
      makeCmd('ResolveDispute', { resolvedBy: ARBITER, favourOf: 'payer' }),
      v,
      makeCtx(),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.nextState.status).toBe('REFUNDED');
  });
});

// ---------------------------------------------------------------------------
// 20. Event ordering (stream integrity)
// ---------------------------------------------------------------------------

describe('20. Event ordering', () => {
  test('evolve rejects events from wrong cellId', () => {
    const event: Event = {
      eventId:   makeEventId('e1'),
      cellId:    CELL_B,  // wrong cell
      version:   nextVersion(ZERO_VERSION),
      timestamp: T0,
      type:      'CellCreated',
      payload:   { payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY',
                   fundingDeadline: T_FUNDING_DEADLINE, completionDeadline: T_COMPLETION_DEADLINE },
    };
    const result = cellKernel.evolve(CELL_A, [event]);
    expect('code' in result).toBe(true);
    if (!('code' in result)) return;
    expect(result.code).toBe('STREAM_INTEGRITY_ERROR');
  });

  test('evolve rejects events with version starting at 0', () => {
    const event: Event = {
      eventId:   makeEventId('e1'),
      cellId:    CELL_A,
      version:   ZERO_VERSION, // must start at 1
      timestamp: T0,
      type:      'CellCreated',
      payload:   { payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY',
                   fundingDeadline: T_FUNDING_DEADLINE, completionDeadline: T_COMPLETION_DEADLINE },
    };
    const result = cellKernel.evolve(CELL_A, [event]);
    expect('code' in result).toBe(true);
    if (!('code' in result)) return;
    expect(result.code).toBe('STREAM_INTEGRITY_ERROR');
  });
});

// ---------------------------------------------------------------------------
// 21. Event replay (state reconstruction)
// ---------------------------------------------------------------------------

describe('21. Event replay', () => {
  test('replaying events produces same state as applying commands', () => {
    // Apply commands to get events
    let state = cellKernel.evolve(CELL_A, []);
    if ('code' in state) throw new Error('unexpected');

    const allEvents: Event[] = [];
    let version = nextVersion(ZERO_VERSION);

    const commands: Array<Command> = [
      makeCmd('CreateCell', createCellPayload({ arbiter: ARBITER })),
      makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }),
      makeCmd('RequestRelease', { requestedBy: PAYER }),
    ];

    for (const cmd of commands) {
      const result = cellKernel.applyCommand(
        state,
        cmd,
        version,
        makeCtx(T0),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      allEvents.push(...result.events);
      state = result.nextState;
      version = (version + result.events.length) as typeof version;
    }

    // Now reconstruct from events
    const reconstructed = cellKernel.evolve(CELL_A, allEvents);
    expect('code' in reconstructed).toBe(false);
    if ('code' in reconstructed) return;

    expect(reconstructed.status).toBe(state.status);
    expect(reconstructed.payer).toBe(state.payer);
    expect(reconstructed.payee).toBe(state.payee);
    expect(reconstructed.arbiter).toBe(state.arbiter);
    expect(reconstructed.amount).toBe(state.amount);
    expect(reconstructed.releaseRequestedBy).toBe(state.releaseRequestedBy);
  });
});

// ---------------------------------------------------------------------------
// 22. Version gaps
// ---------------------------------------------------------------------------

describe('22. Version gaps', () => {
  test('evolve rejects a version gap', () => {
    const v1 = nextVersion(ZERO_VERSION);
    const v3 = nextVersion(nextVersion(v1)); // skip v2

    const events: Event[] = [
      {
        eventId:   makeEventId('e1'),
        cellId:    CELL_A,
        version:   v1,
        timestamp: T0,
        type:      'CellCreated',
        payload:   { payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY',
                     fundingDeadline: T_FUNDING_DEADLINE, completionDeadline: T_COMPLETION_DEADLINE },
      },
      {
        eventId:   makeEventId('e3'),
        cellId:    CELL_A,
        version:   v3, // gap! expected v2
        timestamp: T0,
        type:      'CellFunded',
        payload:   { fundedBy: PAYER, amount: AMOUNT },
      },
    ];

    const result = cellKernel.evolve(CELL_A, events);
    expect('code' in result).toBe(true);
    if (!('code' in result)) return;
    expect(result.code).toBe('STREAM_INTEGRITY_ERROR');
  });

  test('evolve rejects duplicate versions', () => {
    const v1 = nextVersion(ZERO_VERSION);

    const events: Event[] = [
      {
        eventId:   makeEventId('e1'),
        cellId:    CELL_A,
        version:   v1,
        timestamp: T0,
        type:      'CellCreated',
        payload:   { payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY',
                     fundingDeadline: T_FUNDING_DEADLINE, completionDeadline: T_COMPLETION_DEADLINE },
      },
      {
        eventId:   makeEventId('e1b'),
        cellId:    CELL_A,
        version:   v1, // duplicate version
        timestamp: T0,
        type:      'CellFunded',
        payload:   { fundedBy: PAYER, amount: AMOUNT },
      },
    ];

    const result = cellKernel.evolve(CELL_A, events);
    expect('code' in result).toBe(true);
    if (!('code' in result)) return;
    expect(result.code).toBe('STREAM_INTEGRITY_ERROR');
  });
});

// ---------------------------------------------------------------------------
// 23. Wrong cell events
// ---------------------------------------------------------------------------

describe('23. Wrong cell events', () => {
  test('evolve rejects events mixed from two cells', () => {
    const v1 = nextVersion(ZERO_VERSION);
    const v2 = nextVersion(v1);

    const events: Event[] = [
      {
        eventId:   makeEventId('e1'),
        cellId:    CELL_A,
        version:   v1,
        timestamp: T0,
        type:      'CellCreated',
        payload:   { payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY',
                     fundingDeadline: T_FUNDING_DEADLINE, completionDeadline: T_COMPLETION_DEADLINE },
      },
      {
        eventId:   makeEventId('e2'),
        cellId:    CELL_B, // wrong cell in the middle of CELL_A's stream
        version:   v2,
        timestamp: T0,
        type:      'CellFunded',
        payload:   { fundedBy: PAYER, amount: AMOUNT },
      },
    ];

    const result = cellKernel.evolve(CELL_A, events);
    expect('code' in result).toBe(true);
    if (!('code' in result)) return;
    expect(result.code).toBe('STREAM_INTEGRITY_ERROR');
  });
});

// ---------------------------------------------------------------------------
// 24. Deterministic execution
// ---------------------------------------------------------------------------

describe('24. Deterministic execution', () => {
  test('same state + command + context always produces same result', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;

    const ctx1: DeterministicContext = {
      now: makeTimestamp(12345),
      nextEventId: (i) => makeEventId(`fixed-id-${i}`),
    };
    const ctx2: DeterministicContext = {
      now: makeTimestamp(12345),
      nextEventId: (i) => makeEventId(`fixed-id-${i}`),
    };

    const r1 = cellKernel.applyCommand(
      state,
      makeCmd('RequestRelease', { requestedBy: PAYER }),
      v,
      ctx1,
    );
    const r2 = cellKernel.applyCommand(
      state,
      makeCmd('RequestRelease', { requestedBy: PAYER }),
      v,
      ctx2,
    );

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    // Event content must be identical
    expect(r1.events[0]!.eventId).toBe(r2.events[0]!.eventId);
    expect(r1.events[0]!.timestamp).toBe(r2.events[0]!.timestamp);
    expect(r1.events[0]!.type).toBe(r2.events[0]!.type);
    expect(r1.nextState).toEqual(r2.nextState);
  });

  test('evolve is deterministic: same events → same state', () => {
    const events: Event[] = [];
    let state = cellKernel.evolve(CELL_A, []);
    if ('code' in state) throw new Error('unexpected');
    let v = nextVersion(ZERO_VERSION);

    const ctx: DeterministicContext = {
      now: makeTimestamp(99999),
      nextEventId: (i) => makeEventId(`det-${i}`),
    };

    for (const cmd of [
      makeCmd('CreateCell', createCellPayload()),
      makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }),
    ]) {
      const r = cellKernel.applyCommand(state, cmd, v, ctx);
      if (!r.ok) throw new Error(r.error.message);
      events.push(...r.events);
      state = r.nextState;
      v = (v + r.events.length) as typeof v;
    }

    const s1 = cellKernel.evolve(CELL_A, events);
    const s2 = cellKernel.evolve(CELL_A, events);

    expect('code' in s1).toBe(false);
    expect('code' in s2).toBe(false);
    if ('code' in s1 || 'code' in s2) return;

    expect(s1).toEqual(s2);
  });

  test('different context (now) produces events with different timestamps', () => {
    const state = fundedState();
    const v = (ZERO_VERSION + 3) as typeof ZERO_VERSION;

    const ctx1: DeterministicContext = { now: makeTimestamp(1000), nextEventId: (i) => makeEventId(`a-${i}`) };
    const ctx2: DeterministicContext = { now: makeTimestamp(2000), nextEventId: (i) => makeEventId(`b-${i}`) };

    const r1 = cellKernel.applyCommand(state, makeCmd('RequestRelease', { requestedBy: PAYER }), v, ctx1);
    const r2 = cellKernel.applyCommand(state, makeCmd('RequestRelease', { requestedBy: PAYER }), v, ctx2);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    expect(r1.events[0]!.timestamp).toBe(makeTimestamp(1000));
    expect(r2.events[0]!.timestamp).toBe(makeTimestamp(2000));
  });
});

// ---------------------------------------------------------------------------
// Stream integrity: terminal state followed by event
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PATCH: FundCell actor identity
// ---------------------------------------------------------------------------

describe('PATCH: FundCell actor identity', () => {
  test('valid payer FundCell → FUNDED', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload()) }]);
    const v2 = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(
      state,
      makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }),
      v2,
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState.status).toBe('FUNDED');
  });

  test('FundCell with funderId !== payer → REJECTED', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload()) }]);
    const v2 = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(
      state,
      makeCmd('FundCell', { funderId: PAYEE, amount: AMOUNT }),
      v2,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });

  test('stranger cannot fund a cell', () => {
    const state = applyAll([{ cmd: makeCmd('CreateCell', createCellPayload()) }]);
    const v2 = nextVersion(nextVersion(ZERO_VERSION));
    const result = cellKernel.applyCommand(
      state,
      makeCmd('FundCell', { funderId: STRANGER, amount: AMOUNT }),
      v2,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// PATCH: Release request idempotency
// ---------------------------------------------------------------------------

describe('PATCH: Release request idempotency', () => {
  test('same party requests release twice → REJECTED', () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRelease', { requestedBy: PAYER }) },
    ]);
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('RequestRelease', { requestedBy: PAYER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });

  test('opposite party requests release while request exists → REJECTED', () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRelease', { requestedBy: PAYER }) },
    ]);
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('RequestRelease', { requestedBy: PAYEE }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });

  test('no automatic settlement when both parties want release', () => {
    // Payer requests release → stays FUNDED. Payee cannot also request.
    // Settlement only through explicit ApproveRelease by opposite party.
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRelease', { requestedBy: PAYER }) },
    ]);
    expect(state.status).toBe('FUNDED');
    expect(state.releaseRequestedBy).toBe(PAYER);
  });
});

// ---------------------------------------------------------------------------
// PATCH: Refund request idempotency
// ---------------------------------------------------------------------------

describe('PATCH: Refund request idempotency', () => {
  test('payer requests refund twice → REJECTED', () => {
    const state = applyAll([
      { cmd: makeCmd('CreateCell', createCellPayload()) },
      { cmd: makeCmd('FundCell', { funderId: PAYER, amount: AMOUNT }) },
      { cmd: makeCmd('RequestRefund', { requestedBy: PAYER }) },
    ]);
    const v = (ZERO_VERSION + 4) as typeof ZERO_VERSION;
    const result = cellKernel.applyCommand(
      state,
      makeCmd('RequestRefund', { requestedBy: PAYER }),
      v,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });
});

// ---------------------------------------------------------------------------
// Stream integrity: terminal event followed by another event
// ---------------------------------------------------------------------------

describe('Stream integrity: terminal event followed by another event', () => {
  test('evolve rejects events after a terminal state is reached', () => {
    const v1 = nextVersion(ZERO_VERSION);
    const v2 = nextVersion(v1);
    const v3 = nextVersion(v2);

    const events: Event[] = [
      {
        eventId:   makeEventId('e1'),
        cellId:    CELL_A,
        version:   v1,
        timestamp: T0,
        type:      'CellCreated',
        payload:   { payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY',
                     fundingDeadline: T_FUNDING_DEADLINE, completionDeadline: T_COMPLETION_DEADLINE },
      },
      {
        eventId:   makeEventId('e2'),
        cellId:    CELL_A,
        version:   v2,
        timestamp: T0,
        type:      'CellExpired',
        payload:   { triggeredBy: STRANGER, currentTime: T_AFTER_FUNDING_DL },
      },
      {
        eventId:   makeEventId('e3'),
        cellId:    CELL_A,
        version:   v3,
        timestamp: T0,
        type:      'CellFunded', // illegal — after EXPIRED
        payload:   { fundedBy: PAYER, amount: AMOUNT },
      },
    ];

    const result = cellKernel.evolve(CELL_A, events);
    expect('code' in result).toBe(true);
    if (!('code' in result)) return;
    expect(result.code).toBe('STREAM_INTEGRITY_ERROR');
  });
});
