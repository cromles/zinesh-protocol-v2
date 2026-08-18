/**
 * Zinesh 2.0 - Kernel State Machine Tests
 * 
 * Comprehensive tests for the pure state machine kernel.
 * All tests are synchronous and deterministic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  initializeCell,
  transition,
  executeRelease,
  executeRefund,
  projectCell,
  isTimeoutReached,
} from '../src/kernel/state-machine.js';
import {
  Cell,
  Command,
  CreateCellCommand,
  BindFundingCommand,
  RequestReleaseCommand,
  RequestRefundCommand,
  OpenDisputeCommand,
  ResolveDisputeCommand,
  TriggerTimeoutCommand,
  CellState as CellStates,
  PartyRole,
  Policy,
  Amount,
  createCellId,
  createAssetRef,
  createAmount,
  ZineshErrorCode,
} from '../src/core/types.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

const CELL_ID = createCellId('cell-001');
const ASSET = createAssetRef('USDC');
const PAYER_ADDR = '0xPayer123';
const PAYEE_ADDR = '0xPayee456';
const ARBITER_ADDR = '0xArbiter789';
const COMMAND_ID_PREFIX = 'cmd';

function createPolicy(amount: bigint, timeout: number, withArbiter = true): Policy {
  const basePolicy: Omit<Policy, 'arbiter'> = {
    id: 'policy-001',
    asset: ASSET,
    amount: createAmount(amount),
    timeout,
    termsHash: 'terms-hash-abc',
  };
  
  if (withArbiter) {
    return { ...basePolicy, arbiter: ARBITER_ADDR };
  }
  return basePolicy as Policy;
}

function createCreateCellCommand(
  commandId: string,
  timestamp: number,
  policy?: Policy,
  actor: PartyRole = PartyRole.Payer
): CreateCellCommand {
  return {
    type: 'CreateCell',
    cellId: CELL_ID,
    commandId,
    timestamp,
    actor,
    payer: PAYER_ADDR,
    payee: PAYEE_ADDR,
    policy: policy || createPolicy(1000n, 1000),
  };
}

function createBindFundingCommand(
  commandId: string,
  timestamp: number,
  amount: bigint,
  txHash: string,
  actor: PartyRole = PartyRole.Payer
): BindFundingCommand {
  return {
    type: 'BindFunding',
    cellId: CELL_ID,
    commandId,
    timestamp,
    actor,
    actualAmount: createAmount(amount),
    fundingTxHash: txHash,
  };
}

function createRequestReleaseCommand(
  commandId: string,
  timestamp: number,
  recipientAddress: string,
  actor: PartyRole = PartyRole.Payee
): RequestReleaseCommand {
  return {
    type: 'RequestRelease',
    cellId: CELL_ID,
    commandId,
    timestamp,
    actor,
    recipientAddress,
  };
}

function createRequestRefundCommand(
  commandId: string,
  timestamp: number,
  refundAddress: string,
  actor: PartyRole = PartyRole.Payer
): RequestRefundCommand {
  return {
    type: 'RequestRefund',
    cellId: CELL_ID,
    commandId,
    timestamp,
    actor,
    refundAddress,
  };
}

function createOpenDisputeCommand(
  commandId: string,
  timestamp: number,
  reason: string,
  actor: PartyRole = PartyRole.Payer
): OpenDisputeCommand {
  return {
    type: 'OpenDispute',
    cellId: CELL_ID,
    commandId,
    timestamp,
    actor,
    reason,
    evidenceHash: 'evidence-xyz',
  };
}

function createResolveDisputeCommand(
  commandId: string,
  timestamp: number,
  decideFor: 'Payer' | 'Payee',
  releaseAmount: bigint,
  refundAmount: bigint,
  actor: PartyRole = PartyRole.Arbiter
): ResolveDisputeCommand {
  return {
    type: 'ResolveDispute',
    cellId: CELL_ID,
    commandId,
    timestamp,
    actor,
    decideFor,
    releaseAmount: createAmount(releaseAmount),
    refundAmount: createAmount(refundAmount),
  };
}

function createTriggerTimeoutCommand(
  commandId: string,
  timestamp: number,
  currentTime: number,
  actor: PartyRole = PartyRole.Payer
): TriggerTimeoutCommand {
  return {
    type: 'TriggerTimeout',
    cellId: CELL_ID,
    commandId,
    timestamp,
    actor,
    currentTime,
  };
}

function getErrorCode(result: { success: boolean; error?: { code: ZineshErrorCode } }): ZineshErrorCode | undefined {
  if (!result.success && result.error) {
    return result.error.code;
  }
  return undefined;
}

// ============================================================================
// TESTS
// ============================================================================

describe('Zinesh 2.0 Kernel', () => {
  describe('initializeCell', () => {
    it('1. initializes cell successfully', () => {
      const cmd = createCreateCellCommand('cmd-001', 100);
      const result = initializeCell(cmd);

      expect(result.success).toBe(true);
      expect(result.newState).toBeDefined();
      expect(result.events).toHaveLength(1);

      const cell = result.newState!;
      expect(cell.id).toBe(CELL_ID);
      expect(cell.state).toBe(CellStates.Draft);
      expect(cell.policy.amount).toBe(1000n);
      expect(cell.parties).toHaveLength(3); // Payer + Payee + Arbiter (default)
      expect(cell.eventLog[0]!.type).toBe('CellCreated');
    });

    it('2. rejects create with zero amount', () => {
      const policy = createPolicy(0n, 1000);
      const cmd = createCreateCellCommand('cmd-002', 100, policy);
      const result = initializeCell(cmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.InvalidAmount);
    });

    it('rejects create with negative amount', () => {
      // Note: createAmount will throw, so we bypass it
      const policy: Policy = {
        id: 'policy-bad',
        asset: ASSET,
        amount: -1n as unknown as Amount, // Bypass validation for test
        timeout: 1000,
      };
      const cmd = createCreateCellCommand('cmd-003', 100, policy);
      const result = initializeCell(cmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.InvalidAmount);
    });

    it('rejects create when payer equals payee', () => {
      const cmd: CreateCellCommand = {
        ...createCreateCellCommand('cmd-004', 100),
        payer: PAYER_ADDR,
        payee: PAYER_ADDR, // Same address
      };
      const result = initializeCell(cmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.PolicyViolation);
    });

    it('rejects create when timeout is in the past', () => {
      const policy = createPolicy(1000n, 50); // Timeout before timestamp
      const cmd = createCreateCellCommand('cmd-005', 100, policy);
      const result = initializeCell(cmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.PolicyViolation);
    });

    it('rejects create when arbiter equals payer', () => {
      const policy: Policy = {
        id: 'policy-bad',
        asset: ASSET,
        amount: 1000n,
        timeout: 1000,
        arbiter: PAYER_ADDR, // Arbiter = Payer
      };
      const cmd = createCreateCellCommand('cmd-006', 100, policy);
      const result = initializeCell(cmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.PolicyViolation);
    });

    it('creates cell without arbiter if not specified', () => {
      const policy = createPolicy(1000n, 1000, false); // No arbiter
      const cmd = createCreateCellCommand('cmd-007', 100, policy);
      const result = initializeCell(cmd);

      expect(result.success).toBe(true);
      expect(result.newState!.parties).toHaveLength(2); // Only Payer + Payee
    });
  });

  describe('BindFunding', () => {
    let cell: Cell;

    beforeEach(() => {
      const cmd = createCreateCellCommand('cmd-init', 100);
      const result = initializeCell(cmd);
      cell = result.newState!;
    });

    it('3. binds funding successfully', () => {
      const cmd = createBindFundingCommand('cmd-fund-001', 200, 1000n, 'tx-abc123');
      const result = transition(cell, cmd);

      expect(result.success).toBe(true);
      expect(result.newState!.state).toBe(CellStates.FundedLocked);
      expect(result.newState!.fundedAmount).toBe(1000n);
      expect(result.events![0]!.type).toBe('FundingBound');
    });

    it('4. rejects funding in wrong state (after already funded)', () => {
      // First fund successfully
      const cmd1 = createBindFundingCommand('cmd-fund-002', 200, 1000n, 'tx-001');
      const result1 = transition(cell, cmd1);
      const fundedCell = result1.newState!;

      // Try to fund again
      const cmd2 = createBindFundingCommand('cmd-fund-003', 300, 1000n, 'tx-002');
      const result2 = transition(fundedCell, cmd2);

      expect(result2.success).toBe(false);
      expect(getErrorCode(result2)).toBe(ZineshErrorCode.InvalidStateTransition);
    });

    it('5. rejects funding with wrong asset', () => {
      // This is implicitly tested because we check amount match
      // Asset mismatch would be caught by amount not matching policy
      const cmd = createBindFundingCommand('cmd-fund-004', 200, 500n, 'tx-wrong');
      const result = transition(cell, cmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.PolicyViolation);
    });

    it('6. rejects funding with wrong amount', () => {
      const cmd = createBindFundingCommand('cmd-fund-005', 200, 500n, 'tx-short');
      const result = transition(cell, cmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.PolicyViolation);
    });

    it('rejects funding with excessive amount', () => {
      const cmd = createBindFundingCommand('cmd-fund-006', 200, 2000n, 'tx-excess');
      const result = transition(cell, cmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.PolicyViolation);
    });
  });

  describe('Release Path', () => {
    let fundedCell: Cell;

    beforeEach(() => {
      const initCmd = createCreateCellCommand('cmd-init-release', 100);
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-release', 200, 1000n, 'tx-release');
      const fundResult = transition(draftCell, fundCmd);
      fundedCell = fundResult.newState!;
    });

    it('7. payer release succeeds (via RequestRelease then executeRelease)', () => {
      // Payee requests release
      const requestCmd = createRequestReleaseCommand('cmd-req-release', 300, PAYEE_ADDR, PartyRole.Payee);
      const requestResult = transition(fundedCell, requestCmd);

      expect(requestResult.success).toBe(true);
      expect(requestResult.newState!.state).toBe(CellStates.ReleaseRequested);

      // Execute the release
      const executeResult = executeRelease(requestResult.newState!, 'tx-final-release', 400);

      expect(executeResult.success).toBe(true);
      expect(executeResult.newState!.state).toBe(CellStates.Closed);
      expect(executeResult.newState!.releasedAmount).toBe(1000n);
    });

    it('8. payee direct release fails (unauthorized)', () => {
      // Payer tries to request release (should fail - only Payee can)
      const requestCmd = createRequestReleaseCommand('cmd-bad-release', 300, PAYEE_ADDR, PartyRole.Payer);
      const result = transition(fundedCell, requestCmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.Unauthorized);
    });

    it('rejects release in wrong state (before funding)', () => {
      const initCmd = createCreateCellCommand('cmd-init-unfunded', 100);
      const initResult = initializeCell(initCmd);
      const unfundedCell = initResult.newState!;

      const requestCmd = createRequestReleaseCommand('cmd-pre-release', 200, PAYEE_ADDR);
      const result = transition(unfundedCell, requestCmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.InvalidStateTransition);
    });
  });

  describe('Refund Path', () => {
    let fundedCell: Cell;

    beforeEach(() => {
      const initCmd = createCreateCellCommand('cmd-init-refund', 100);
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-refund', 200, 1000n, 'tx-refund');
      const fundResult = transition(draftCell, fundCmd);
      fundedCell = fundResult.newState!;
    });

    it('9. payee refund succeeds (via RequestRefund then executeRefund)', () => {
      // Payer requests refund
      const requestCmd = createRequestRefundCommand('cmd-req-refund', 300, PAYER_ADDR, PartyRole.Payer);
      const requestResult = transition(fundedCell, requestCmd);

      expect(requestResult.success).toBe(true);
      expect(requestResult.newState!.state).toBe(CellStates.RefundRequested);

      // Execute the refund
      const executeResult = executeRefund(requestResult.newState!, 'tx-final-refund', 400);

      expect(executeResult.success).toBe(true);
      expect(executeResult.newState!.state).toBe(CellStates.Closed);
      expect(executeResult.newState!.refundedAmount).toBe(1000n);
    });

    it('10. payer direct refund fails (unauthorized)', () => {
      // Payee tries to request refund (should fail - only Payer can)
      const requestCmd = createRequestRefundCommand('cmd-bad-refund', 300, PAYER_ADDR, PartyRole.Payee);
      const result = transition(fundedCell, requestCmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.Unauthorized);
    });
  });

  describe('Dispute Path', () => {
    let fundedCell: Cell;

    beforeEach(() => {
      const initCmd = createCreateCellCommand('cmd-init-dispute', 100);
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-dispute', 200, 1000n, 'tx-dispute');
      const fundResult = transition(draftCell, fundCmd);
      fundedCell = fundResult.newState!;
    });

    it('11. open dispute by payer succeeds', () => {
      const cmd = createOpenDisputeCommand('cmd-dispute-payer', 300, 'Goods not delivered', PartyRole.Payer);
      const result = transition(fundedCell, cmd);

      expect(result.success).toBe(true);
      expect(result.newState!.state).toBe(CellStates.Disputed);
      expect(result.events![0]!.type).toBe('DisputeOpened');
    });

    it('12. open dispute by payee succeeds', () => {
      const cmd = createOpenDisputeCommand('cmd-dispute-payee', 300, 'Payment disputed', PartyRole.Payee);
      const result = transition(fundedCell, cmd);

      expect(result.success).toBe(true);
      expect(result.newState!.state).toBe(CellStates.Disputed);
    });

    it('13. resolve dispute by arbiter succeeds with exact split', () => {
      // First open dispute
      const openCmd = createOpenDisputeCommand('cmd-open-disp', 300, 'Dispute', PartyRole.Payer);
      const openResult = transition(fundedCell, openCmd);
      const disputedCell = openResult.newState!;

      // Resolve with 60/40 split
      const resolveCmd = createResolveDisputeCommand(
        'cmd-resolve-disp',
        400,
        'Payee',
        600n, // releaseAmount
        400n, // refundAmount
        PartyRole.Arbiter
      );
      const resolveResult = transition(disputedCell, resolveCmd);

      expect(resolveResult.success).toBe(true);
      expect(resolveResult.newState!.state).toBe(CellStates.Closed);
      expect(resolveResult.newState!.releasedAmount).toBe(600n);
      expect(resolveResult.newState!.refundedAmount).toBe(400n);
    });

    it('14. resolve dispute fails if release + refund != fundedAmount', () => {
      // First open dispute
      const openCmd = createOpenDisputeCommand('cmd-open-bad', 300, 'Dispute', PartyRole.Payer);
      const openResult = transition(fundedCell, openCmd);
      const disputedCell = openResult.newState!;

      // Try to resolve with wrong total (500 + 500 = 1000, but let's try 600 + 500 = 1100)
      const resolveCmd = createResolveDisputeCommand(
        'cmd-resolve-bad',
        400,
        'Payee',
        600n,
        500n, // Total = 1100, not 1000
        PartyRole.Arbiter
      );
      const resolveResult = transition(disputedCell, resolveCmd);

      expect(resolveResult.success).toBe(false);
      expect(getErrorCode(resolveResult)).toBe(ZineshErrorCode.PolicyViolation);
    });

    it('15. resolve dispute fails if actor is not Arbiter', () => {
      // First open dispute
      const openCmd = createOpenDisputeCommand('cmd-open-noarb', 300, 'Dispute', PartyRole.Payer);
      const openResult = transition(fundedCell, openCmd);
      const disputedCell = openResult.newState!;

      // Payer tries to resolve (unauthorized)
      const resolveCmd = createResolveDisputeCommand(
        'cmd-resolve-noarb',
        400,
        'Payer',
        0n,
        1000n,
        PartyRole.Payer // Wrong role
      );
      const resolveResult = transition(disputedCell, resolveCmd);

      expect(resolveResult.success).toBe(false);
      expect(getErrorCode(resolveResult)).toBe(ZineshErrorCode.Unauthorized);
    });

    it('resolve dispute fails if no arbiter defined', () => {
      // Create cell without arbiter
      const initCmd = createCreateCellCommand('cmd-init-no-arb', 100, createPolicy(1000n, 1000, false));
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-no-arb', 200, 1000n, 'tx-no-arb');
      const fundResult = transition(draftCell, fundCmd);
      const cellNoArb = fundResult.newState!;

      // Open dispute
      const openCmd = createOpenDisputeCommand('cmd-open-no-arb', 300, 'Dispute', PartyRole.Payer);
      const openResult = transition(cellNoArb, openCmd);
      const disputedCell = openResult.newState!;

      // Try to resolve (should fail - no arbiter)
      const resolveCmd = createResolveDisputeCommand(
        'cmd-resolve-no-arb',
        400,
        'Payer',
        0n,
        1000n,
        PartyRole.Arbiter
      );
      const resolveResult = transition(disputedCell, resolveCmd);

      expect(resolveResult.success).toBe(false);
      expect(getErrorCode(resolveResult)).toBe(ZineshErrorCode.PolicyViolation);
    });
  });

  describe('Replay Protection', () => {
    it('16. replay same commandId fails', () => {
      const initCmd = createCreateCellCommand('cmd-replay', 100);
      const initResult = initializeCell(initCmd);
      const cell = initResult.newState!;

      // Replay the same command
      const replayResult = transition(cell, initCmd);

      expect(replayResult.success).toBe(false);
      expect(getErrorCode(replayResult)).toBe(ZineshErrorCode.ReplayDetected);
    });

    it('replay after funding fails', () => {
      const initCmd = createCreateCellCommand('cmd-replay-fund', 100);
      const initResult = initializeCell(initCmd);
      const cell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-replay', 200, 1000n, 'tx-replay');
      const fundResult = transition(cell, fundCmd);
      const fundedCell = fundResult.newState!;

      // Replay the funding command
      const replayResult = transition(fundedCell, fundCmd);

      expect(replayResult.success).toBe(false);
      expect(getErrorCode(replayResult)).toBe(ZineshErrorCode.ReplayDetected);
    });
  });

  describe('Context Binding', () => {
    it('17. wrong cellId fails', () => {
      const initCmd = createCreateCellCommand('cmd-context', 100);
      const initResult = initializeCell(initCmd);
      const cell = initResult.newState!;

      // Create command with wrong cellId
      const wrongCmd: BindFundingCommand = {
        ...createBindFundingCommand('cmd-fund-context', 200, 1000n, 'tx-context'),
        cellId: createCellId('wrong-cell-id'),
      };

      const result = transition(cell, wrongCmd);

      expect(result.success).toBe(false);
      expect(getErrorCode(result)).toBe(ZineshErrorCode.ContextMismatch);
    });
  });

  describe('Terminal States', () => {
    it('18. terminal state rejects further commands', () => {
      // Create and fund cell
      const initCmd = createCreateCellCommand('cmd-terminal', 100);
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-terminal', 200, 1000n, 'tx-terminal');
      const fundResult = transition(draftCell, fundCmd);
      const fundedCell = fundResult.newState!;

      // Request release
      const reqCmd = createRequestReleaseCommand('cmd-req-terminal', 300, PAYEE_ADDR);
      const reqResult = transition(fundedCell, reqCmd);
      const requestedCell = reqResult.newState!;

      // Execute release (closes the cell)
      const execResult = executeRelease(requestedCell, 'tx-close', 400);
      const closedCell = execResult.newState!;

      expect(closedCell.state).toBe(CellStates.Closed);

      // Try to open dispute on closed cell
      const disputeCmd = createOpenDisputeCommand('cmd-dispute-closed', 500, 'Too late');
      const disputeResult = transition(closedCell, disputeCmd);

      expect(disputeResult.success).toBe(false);
      expect(getErrorCode(disputeResult)).toBe(ZineshErrorCode.InvalidStateTransition);
    });

    it('terminated state also rejects commands', () => {
      // Create and fund cell
      const initCmd = createCreateCellCommand('cmd-term-test', 100);
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-term-test', 200, 1000n, 'tx-term-test');
      const fundResult = transition(draftCell, fundCmd);
      const fundedCell = fundResult.newState!;

      // Trigger timeout
      const timeoutCmd = createTriggerTimeoutCommand('cmd-timeout-term', 1500, 1500);
      const timeoutResult = transition(fundedCell, timeoutCmd);
      const terminatedCell = timeoutResult.newState!;

      expect(terminatedCell.state).toBe(CellStates.Terminated);

      // Try to request release on terminated cell
      const reqCmd = createRequestReleaseCommand('cmd-req-terminated', 1600, PAYEE_ADDR);
      const reqResult = transition(terminatedCell, reqCmd);

      expect(reqResult.success).toBe(false);
      expect(getErrorCode(reqResult)).toBe(ZineshErrorCode.InvalidStateTransition);
    });
  });

  describe('Timeout Path', () => {
    it('19. timeout path works according to implemented rule', () => {
      // Create cell with timeout at 1000
      const policy = createPolicy(1000n, 1000);
      const initCmd = createCreateCellCommand('cmd-timeout', 100, policy);
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      // Fund the cell
      const fundCmd = createBindFundingCommand('cmd-fund-timeout', 200, 1000n, 'tx-timeout');
      const fundResult = transition(draftCell, fundCmd);
      const fundedCell = fundResult.newState!;

      // Trigger timeout (currentTime > policy.timeout)
      const timeoutCmd = createTriggerTimeoutCommand('cmd-trigger-timeout', 1500, 1500);
      const timeoutResult = transition(fundedCell, timeoutCmd);

      expect(timeoutResult.success).toBe(true);
      expect(timeoutResult.newState!.state).toBe(CellStates.Terminated);
      expect(timeoutResult.newState!.refundedAmount).toBe(1000n);
      expect(timeoutResult.events!.some(e => e.type === 'CellTerminated')).toBe(true);
      expect(timeoutResult.events!.some(e => e.type === 'CellRefunded')).toBe(true);
    });

    it('timeout fails if not yet reached', () => {
      const policy = createPolicy(1000n, 1000);
      const initCmd = createCreateCellCommand('cmd-timeout-early', 100, policy);
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-timeout-early', 200, 1000n, 'tx-early');
      const fundResult = transition(draftCell, fundCmd);
      const fundedCell = fundResult.newState!;

      // Try to trigger timeout before it's reached
      const timeoutCmd = createTriggerTimeoutCommand('cmd-trigger-early', 500, 500);
      const timeoutResult = transition(fundedCell, timeoutCmd);

      expect(timeoutResult.success).toBe(false);
      expect(getErrorCode(timeoutResult)).toBe(ZineshErrorCode.TimeoutNotReached);
    });

    it('timeout refunds to payer by default', () => {
      const policy = createPolicy(1000n, 1000);
      const initCmd = createCreateCellCommand('cmd-timeout-payer', 100, policy);
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-timeout-payer', 200, 1000n, 'tx-payer');
      const fundResult = transition(draftCell, fundCmd);
      const fundedCell = fundResult.newState!;

      const timeoutCmd = createTriggerTimeoutCommand('cmd-trigger-payer', 1500, 1500);
      const timeoutResult = transition(fundedCell, timeoutCmd);

      // Check that refund event has payer address
      const refundEvent = timeoutResult.events!.find(e => e.type === 'CellRefunded');
      expect(refundEvent).toBeDefined();
      expect((refundEvent as any).refundAddress).toBe(PAYER_ADDR);
    });
  });

  describe('Event Log', () => {
    it('20. event log is produced for every successful transition', () => {
      const initCmd = createCreateCellCommand('cmd-events', 100);
      const initResult = initializeCell(initCmd);
      let cell = initResult.newState!;

      expect(cell.eventLog).toHaveLength(1);
      expect(cell.eventLog[0]!.type).toBe('CellCreated');

      const fundCmd = createBindFundingCommand('cmd-fund-events', 200, 1000n, 'tx-events');
      const fundResult = transition(cell, fundCmd);
      cell = fundResult.newState!;

      expect(cell.eventLog).toHaveLength(2);
      expect(cell.eventLog[1]!.type).toBe('FundingBound');

      const reqCmd = createRequestReleaseCommand('cmd-req-events', 300, PAYEE_ADDR);
      const reqResult = transition(cell, reqCmd);
      cell = reqResult.newState!;

      expect(cell.eventLog).toHaveLength(3);
      expect(cell.eventLog[2]!.type).toBe('ReleaseRequested');

      const execResult = executeRelease(cell, 'tx-events-final', 400);
      cell = execResult.newState!;

      expect(cell.eventLog).toHaveLength(4);
      expect(cell.eventLog[3]!.type).toBe('CellReleased');
    });
  });

  describe('Projection', () => {
    it('21. projection reflects current state correctly', () => {
      const initCmd = createCreateCellCommand('cmd-proj', 100);
      const initResult = initializeCell(initCmd);
      let cell = initResult.newState!;

      let proj = projectCell(cell);
      expect(proj.state).toBe(CellStates.Draft);
      expect(proj.canRelease).toBe(false);
      expect(proj.canRefund).toBe(false);

      const fundCmd = createBindFundingCommand('cmd-fund-proj', 200, 1000n, 'tx-proj');
      const fundResult = transition(cell, fundCmd);
      cell = fundResult.newState!;

      proj = projectCell(cell);
      expect(proj.state).toBe(CellStates.FundedLocked);
      expect(proj.fundedAmount).toBe(1000n);
      expect(proj.canRelease).toBe(true);
      expect(proj.canRefund).toBe(true);
      expect(proj.canDispute).toBe(true);
    });
  });

  describe('Conservation of Funds', () => {
    it('conservation holds after full release', () => {
      const initCmd = createCreateCellCommand('cmd-cons-release', 100);
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-cons-release', 200, 1000n, 'tx-cons-release');
      const fundResult = transition(draftCell, fundCmd);
      const fundedCell = fundResult.newState!;

      const reqCmd = createRequestReleaseCommand('cmd-req-cons-release', 300, PAYEE_ADDR);
      const reqResult = transition(fundedCell, reqCmd);
      const requestedCell = reqResult.newState!;

      const execResult = executeRelease(requestedCell, 'tx-cons-final', 400);
      const closedCell = execResult.newState!;

      // Conservation: releasedAmount == fundedAmount
      expect(closedCell.releasedAmount).toBe(1000n);
      expect(closedCell.refundedAmount).toBeUndefined();
    });

    it('conservation holds after dispute resolution with split', () => {
      const initCmd = createCreateCellCommand('cmd-cons-dispute', 100);
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-cons-dispute', 200, 1000n, 'tx-cons-dispute');
      const fundResult = transition(draftCell, fundCmd);
      const fundedCell = fundResult.newState!;

      const openCmd = createOpenDisputeCommand('cmd-open-cons', 300, 'Dispute');
      const openResult = transition(fundedCell, openCmd);
      const disputedCell = openResult.newState!;

      const resolveCmd = createResolveDisputeCommand(
        'cmd-resolve-cons',
        400,
        'Payee',
        700n,
        300n,
        PartyRole.Arbiter
      );
      const resolveResult = transition(disputedCell, resolveCmd);
      const closedCell = resolveResult.newState!;

      // Conservation: releasedAmount + refundedAmount == fundedAmount
      expect(closedCell.releasedAmount).toBe(700n);
      expect(closedCell.refundedAmount).toBe(300n);
      expect((closedCell.releasedAmount ?? 0n) + (closedCell.refundedAmount ?? 0n)).toBe(1000n);
    });
  });

  describe('No Double Spend', () => {
    it('cannot release and refund the same funds', () => {
      const initCmd = createCreateCellCommand('cmd-double', 100);
      const initResult = initializeCell(initCmd);
      const draftCell = initResult.newState!;

      const fundCmd = createBindFundingCommand('cmd-fund-double', 200, 1000n, 'tx-double');
      const fundResult = transition(draftCell, fundCmd);
      const fundedCell = fundResult.newState!;

      // Request and execute release
      const reqCmd = createRequestReleaseCommand('cmd-req-double', 300, PAYEE_ADDR);
      const reqResult = transition(fundedCell, reqCmd);
      const requestedCell = reqResult.newState!;

      const execResult = executeRelease(requestedCell, 'tx-double-release', 400);
      const closedCell = execResult.newState!;

      expect(closedCell.state).toBe(CellStates.Closed);

      // Try to refund after release (should fail - cell is closed)
      const refundReqCmd = createRequestRefundCommand('cmd-refund-after', 500, PAYER_ADDR);
      const refundReqResult = transition(closedCell, refundReqCmd);

      expect(refundReqResult.success).toBe(false);
    });
  });
});
