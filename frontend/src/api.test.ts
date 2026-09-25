import { afterEach, describe, expect, test, vi } from 'vitest';
import { currentSession, getCells, switchRole } from './api';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
});
