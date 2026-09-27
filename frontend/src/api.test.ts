import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, currentRole, currentSession, createCell, getCells, subscribeToRole, switchRole, userMessage } from './api';
import { formatTryAmount, tryAmountToKurus } from './money';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('TRY and kuruş conversion', () => {
  test.each([
    ['10000', '100,00 TRY'],
    ['1050', '10,50 TRY'],
    ['99', '0,99 TRY'],
  ])('formats %s kuruş as %s', (kuruş, expected) => {
    expect(formatTryAmount(kuruş)).toBe(expected);
  });

  test.each([
    ['100,00', '10000'],
    ['100.00', '10000'],
    ['10,5', '1050'],
    ['0,99', '99'],
    ['0001.20', '120'],
  ])('parses %s TRY into %s kuruş', (tryAmount, expected) => {
    expect(tryAmountToKurus(tryAmount)).toBe(expected);
  });

  test.each(['', '0', '0,00', '-1', '+1', '1,234', '1.234,00', '1,', ',50', '1 000', '1e2'])
    ('rejects invalid TRY input %j', (value) => {
      expect(() => tryAmountToKurus(value)).toThrow();
    });

  test('rejects values beyond the backend 31-digit kuruş range', () => {
    expect(() => tryAmountToKurus(`${'9'.repeat(30)},99`)).toThrow();
  });
});

describe('frontend development API client', () => {
  test('keeps role JWT in memory and sends it to the proxied cell list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt-payer', expiresIn: 300, role: 'payer' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cells: [] })));
    vi.stubGlobal('fetch', fetchMock);
    await switchRole('payer');
    expect(currentSession()?.token).toBe('jwt-payer');
    expect(await getCells()).toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/development/auth/token');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/cells');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { authorization: 'Bearer jwt-payer' } });
  });

  test('refreshes the same development role after a 401', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt-payee', expiresIn: 300, role: 'payee' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt-payee-new', expiresIn: 300, role: 'payee' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cells: [] })));
    vi.stubGlobal('fetch', fetchMock);
    await switchRole('payee'); await getCells();
    expect(currentSession()?.role).toBe('payee');
    expect(currentSession()?.token).toBe('jwt-payee-new');
  });

  test.each(['payer', 'payee'] as const)('keeps the selected %s role after token expiry', async (role) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: `jwt-${role}`, expiresIn: 300, role })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: `jwt-${role}-renewed`, expiresIn: 300, role })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cells: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await switchRole(role);
    vi.setSystemTime(new Date('2026-01-01T00:05:01.000Z'));
    expect(currentSession()).toBeNull();
    await expect(getCells()).resolves.toEqual([]);

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ role });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ headers: { authorization: `Bearer jwt-${role}-renewed` } });
    expect(currentRole()).toBe(role);
    expect(currentSession()?.role).toBe(role);
  });

  test('clears role and session when refresh fails and does not default to payer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt-payee', expiresIn: 300, role: 'payee' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'RUNTIME_UNAVAILABLE' } }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const roles: Array<string | null> = [];
    const unsubscribe = subscribeToRole((role) => roles.push(role));

    await switchRole('payee');
    vi.setSystemTime(new Date('2026-01-01T00:05:01.000Z'));
    await expect(getCells()).rejects.toMatchObject({ status: 503 });
    expect(currentSession()).toBeNull();
    expect(currentRole()).toBeNull();
    expect(roles.at(-1)).toBeNull();

    await expect(getCells()).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  test('converts user-entered TRY to the backend integer-string amount', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt-payer', expiresIn: 300, role: 'payer' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ outcome: 'SUCCESS' })));
    vi.stubGlobal('fetch', fetchMock);
    await switchRole('payer');
    await createCell({ payer: 'development-payer', payee: 'development-payee', amountTry: '100,00', description: 'Test' });
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.command.payload.amount).toBe('10000');
    expect(typeof body.command.payload.amount).toBe('string');
  });
});

describe('user-facing API errors', () => {
  test.each([
    [401, 'UNAUTHENTICATED', 'Oturum doğrulanamadı. Lütfen rolünüzü yeniden seçin.'],
    [403, 'COMMAND_NOT_PERMITTED', 'Bu işlem için yetkiniz yok.'],
    [404, 'NOT_FOUND', 'Anlaşma bulunamadı.'],
    [409, 'IDEMPOTENCY_CONFLICT', 'İstek başka bir işlemle çakıştı. Lütfen sayfayı yenileyip tekrar deneyin.'],
    [409, 'FUNDING_DISPUTE_BLOCKED', 'Anlaşmanın mevcut durumu bu işleme izin vermiyor.'],
    [503, 'RUNTIME_UNAVAILABLE', 'Hizmet şu anda kullanılamıyor. Lütfen daha sonra tekrar deneyin.'],
    [500, 'BACKEND_UNAVAILABLE', 'Hizmet şu anda kullanılamıyor. Lütfen daha sonra tekrar deneyin.'],
  ])('maps HTTP %i / %s to a user-friendly message', (status, code, expected) => {
    const message = userMessage(new ApiError(code, status));
    expect(message).toBe(expected);
    expect(message).not.toContain(code);
  });

  test('maps network errors to a friendly service message', () => {
    expect(userMessage(new TypeError('Failed to fetch')))
      .toBe('Hizmete bağlanılamadı. Bağlantınızı kontrol edip tekrar deneyin.');
  });
});
