export type Role = 'payer' | 'payee';
export type CellStatus = 'CREATED' | 'FUNDED' | 'RELEASED' | 'REFUNDED' | 'DISPUTED' | 'EXPIRED';
export type AcceptanceStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export interface CellSummary {
  cellId: string;
  counterpartyId: string;
  description?: string;
  amount: string | number | bigint;
  currency: 'TRY';
  status: CellStatus;
  acceptanceStatus: AcceptanceStatus;
  releaseRequestedBy?: string;
  fundingDeadline: number;
  completionDeadline: number;
  version: number;
}

export interface CellState {
  cellId: string;
  payer: string;
  payee: string;
  description?: string;
  amount: string | number | bigint;
  currency: 'TRY';
  status: CellStatus;
  acceptanceStatus: AcceptanceStatus;
  releaseRequestedBy?: string;
  fundingDeadline: number;
  completionDeadline: number;
}

interface TokenResponse { token: string; expiresIn: number; role: Role }
interface CommandResponse { outcome: string; error?: { code: string }; nextState?: unknown }
export interface Session { role: Role; token: string; expiresAt: number }

let session: Session | null = null;

export function currentSession(): Session | null {
  if (session && session.expiresAt <= Date.now()) session = null;
  return session;
}

export async function switchRole(role: Role): Promise<Session> {
  session = null;
  const response = await fetch('/api/development/auth/token', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!response.ok) throw new ApiError(await readCode(response), response.status);
  const result = await response.json() as TokenResponse;
  session = { role, token: result.token, expiresAt: Date.now() + result.expiresIn * 1000 };
  return session;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let active = currentSession();
  if (!active) active = await switchRole('payer');
  const send = (token: string) => fetch(`/api${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers, authorization: `Bearer ${token}` },
  });
  let response = await send(active.token);
  if (response.status === 401) {
    active = await switchRole(active.role);
    response = await send(active.token);
  }
  if (!response.ok) throw new ApiError(await readCode(response), response.status);
  return response.json() as Promise<T>;
}

async function readCode(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: { code?: string } };
    return data.error?.code ?? `HTTP_${response.status}`;
  } catch { return response.status >= 500 ? 'BACKEND_UNAVAILABLE' : `HTTP_${response.status}`; }
}

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export async function getCells(): Promise<CellSummary[]> {
  return (await api<{ cells: CellSummary[] }>('/cells')).cells;
}

export async function getCell(cellId: string): Promise<CellState> {
  return (await api<{ cell: { state: CellState } }>('/cells/' + encodeURIComponent(cellId))).cell.state;
}

export async function createCell(input: { payer: string; payee: string; amount: string; description: string }): Promise<CommandResponse & { cellId: string }> {
  const cellId = crypto.randomUUID();
  const result = await api<CommandResponse>('/commands', { method: 'POST', body: JSON.stringify({ command: {
    commandId: crypto.randomUUID(), cellId, type: 'CreateCell',
    payload: { payer: input.payer, payee: input.payee, amount: input.amount,
      currency: 'TRY', description: input.description,
      fundingDeadline: Date.now() + 7 * 24 * 60 * 60 * 1000,
      completionDeadline: Date.now() + 14 * 24 * 60 * 60 * 1000 },
  } }) });
  return { ...result, cellId };
}

export function acceptCell(cellId: string): Promise<CommandResponse> {
  return command(cellId, 'AcceptCell', { acceptedBy: 'development-payee' });
}

export function rejectCell(cellId: string): Promise<CommandResponse> {
  return command(cellId, 'RejectCell', { rejectedBy: 'development-payee' });
}

export function prototypeFunding(cellId: string): Promise<CommandResponse> {
  return api('/prototype-funding', { method: 'POST', body: JSON.stringify({ commandId: crypto.randomUUID(), cellId }) });
}

export function requestRelease(cellId: string): Promise<CommandResponse> {
  return command(cellId, 'RequestRelease', { requestedBy: currentSession()?.role === 'payer' ? 'development-payer' : 'development-payee' });
}

export function approveRelease(cellId: string): Promise<CommandResponse> {
  return command(cellId, 'ApproveRelease', { approvedBy: currentSession()?.role === 'payer' ? 'development-payer' : 'development-payee' });
}

function command(cellId: string, type: string, payload: Record<string, string>): Promise<CommandResponse> {
  return api('/commands', { method: 'POST', body: JSON.stringify({ command: {
    commandId: crypto.randomUUID(), cellId, type, payload,
  } }) });
}
