import { describe, expect, test, vi } from 'vitest';
import type { CellState } from './api';
import { ApiError } from './api';
import { agreementRoomIsLoading, agreementRoomViewOnFailure, agreementRoomViewOnLoad, agreementRoomViewOnSuccess,
  agreementStateMessage, canCreateAgreement, loadAgreementRoomCell, statusLabel, visibleAgreementActions } from './ui';

function cell(overrides: Partial<CellState> = {}): CellState {
  return {
    cellId: 'cell-test', payer: 'development-payer', payee: 'development-payee', amount: '10000', currency: 'TRY',
    status: 'CREATED', acceptanceStatus: 'PENDING', fundingDeadline: 100, completionDeadline: 200, ...overrides,
  };
}

const noActions = { accept: false, demoFunding: false, requestRelease: false, approveRelease: false };

describe('agreement state UI actions', () => {
  test('CreateCell form is available only to the Payer role', () => {
    expect(canCreateAgreement('payer')).toBe(true);
    expect(canCreateAgreement('payee')).toBe(false);
    expect(canCreateAgreement(null)).toBe(false);
  });

  test('EXPIRED + PENDING hides Payee accept and reject actions', () => {
    expect(visibleAgreementActions(cell({ status: 'EXPIRED', acceptanceStatus: 'PENDING' }), 'payee')).toEqual(noActions);
  });

  test('EXPIRED status takes precedence over pending acceptance', () => {
    expect(statusLabel('EXPIRED', 'PENDING')).toBe('Süresi doldu');
  });

  test('REJECTED agreement has no remaining actions', () => {
    expect(visibleAgreementActions(cell({ acceptanceStatus: 'REJECTED' }), 'payee')).toEqual(noActions);
    expect(statusLabel('CREATED', 'REJECTED')).toBe('Reddedildi');
  });

  test('RELEASED agreement has no funding or release actions', () => {
    expect(visibleAgreementActions(cell({ status: 'RELEASED', acceptanceStatus: 'ACCEPTED' }), 'payer')).toEqual(noActions);
  });

  test('REFUNDED agreement has no remaining actions', () => {
    expect(visibleAgreementActions(cell({ status: 'REFUNDED', acceptanceStatus: 'ACCEPTED' }), 'payer')).toEqual(noActions);
  });

  test('DISPUTED agreement has no remaining actions', () => {
    expect(visibleAgreementActions(cell({ status: 'DISPUTED', acceptanceStatus: 'ACCEPTED' }), 'payee')).toEqual(noActions);
  });
});

describe('refund request state display', () => {
  test('shows that the Payer requested a refund and Payee approval is pending', () => {
    const state = cell({ status: 'FUNDED', acceptanceStatus: 'ACCEPTED', refundRequestedBy: 'development-payer' });
    expect(agreementStateMessage(state)).toBe('İade talebi bekliyor. Payee onayı bekleniyor.');
  });

  test('shows no pending refund message when refundRequestedBy is absent', () => {
    expect(agreementStateMessage(cell({ status: 'FUNDED', acceptanceStatus: 'ACCEPTED' }))).toBeNull();
  });

  test('REFUNDED takes precedence over a retained refund request field', () => {
    expect(agreementStateMessage(cell({ status: 'REFUNDED', acceptanceStatus: 'ACCEPTED',
      refundRequestedBy: 'development-payer' }))).toContain('İade edildi');
  });

  test('does not expose a refund request action when a request is already present', () => {
    const actions = visibleAgreementActions(cell({ status: 'FUNDED', acceptanceStatus: 'ACCEPTED',
      refundRequestedBy: 'development-payer' }), 'payer');
    expect(actions).not.toHaveProperty('requestRefund');
    expect(actions).not.toHaveProperty('approveRefund');
  });
});

describe('agreement room loading lifecycle', () => {
  test('a role change performs another detail GET for the same cell', async () => {
    const fetchCell = vi.fn(async () => cell());
    await loadAgreementRoomCell('cell-test', 'payer', fetchCell);
    await loadAgreementRoomCell('cell-test', 'payee', fetchCell);
    expect(fetchCell).toHaveBeenNthCalledWith(1, 'cell-test');
    expect(fetchCell).toHaveBeenNthCalledWith(2, 'cell-test');
    expect(fetchCell).toHaveBeenCalledTimes(2);
  });

  test.each([403, 404])('a detail %i response clears the previously loaded cell', (status) => {
    const loading = agreementRoomViewOnLoad('payer:cell-test');
    expect(loading.cell).toBeNull();
    expect(agreementRoomViewOnFailure('payer:cell-test', new ApiError('NOT_FOUND', status)))
      .toMatchObject({ cell: null, loading: false });
  });

  test('detail GET failure leaves no stale cell from which action buttons can be rendered', () => {
    const failed = agreementRoomViewOnFailure('payer:cell-test', new ApiError('NOT_FOUND', 404));
    expect(failed.cell).toBeNull();
    expect(failed.error).toBeTruthy();
  });

  test('successful command followed by failed detail GET clears the old action state', () => {
    const beforeCommand = agreementRoomViewOnSuccess('payer:cell-test', cell({ status: 'FUNDED', acceptanceStatus: 'ACCEPTED' }));
    expect(visibleAgreementActions(beforeCommand.cell!, 'payer').requestRelease).toBe(true);
    const refreshing = agreementRoomViewOnLoad('payer:cell-test');
    expect(refreshing.cell).toBeNull();
    const failed = agreementRoomViewOnFailure('payer:cell-test', new ApiError('UNAVAILABLE', 503));
    expect(failed.cell).toBeNull();
    expect(failed.error).toBeTruthy();
  });

  test('loading view has no cell state for rendering old actions', () => {
    const loading = agreementRoomViewOnLoad('payer:cell-test');
    expect(loading).toMatchObject({ cell: null, loading: true, error: '' });
  });

  test('successful detail load preserves state and its valid actions', () => {
    const loaded = agreementRoomViewOnSuccess('payer:cell-test', cell({ status: 'FUNDED', acceptanceStatus: 'ACCEPTED' }));
    expect(loaded.cell).toEqual(cell({ status: 'FUNDED', acceptanceStatus: 'ACCEPTED' }));
    expect(visibleAgreementActions(loaded.cell!, 'payer').requestRelease).toBe(true);
  });

  test('a role or cell change immediately hides state from the previous scope', () => {
    const previous = agreementRoomViewOnSuccess('payer:cell-test', cell());
    expect(agreementRoomIsLoading(previous, 'payee:cell-test')).toBe(true);
    expect(agreementRoomIsLoading(previous, 'payer:another-cell')).toBe(true);
  });
});
