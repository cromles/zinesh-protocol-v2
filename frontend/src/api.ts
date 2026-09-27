import { AmountInputError, tryAmountToKurus } from './money';

export type Role = 'payer' | 'payee';
export const DEVELOPMENT_PAYER_ID = 'development-payer';
export const DEVELOPMENT_PAYEE_ID = 'development-payee';
export type CellStatus = 'CREATED' | 'FUNDED' | 'RELEASED' | 'REFUNDED' | 'DISPUTED' | 'EXPIRED';
export type AcceptanceStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export interface CellSummary {
  cellId: string;
  counterpartyId: string;
  description?: string;
  amount: string;
  currency: 'TRY';
  status: CellStatus;
  acceptanceStatus: AcceptanceStatus;
  fundingDeadline: number;
  completionDeadline: number;
  version: number;
}

export interface CellState {
  cellId: string;
  payer: string;
  payee: string;
  description?: string;
  amount: string;
  currency: 'TRY';
  status: CellStatus;
  acceptanceStatus: AcceptanceStatus;
  releaseRequestedBy?: string;
  refundRequestedBy?: string;
  arbiter?: string;
  fundedAt?: number;
  fundingDeadline: number;
  completionDeadline: number;
}

interface TokenResponse { token: string; expiresIn: number; role: Role }
interface CommandEvent { eventId: string; cellId: string; version: number; timestamp: number; type: string; payload: Record<string, unknown> }
export type CommandResponse =
  | { outcome: 'SUCCESS'; events: CommandEvent[]; nextState: CellState; version: number }
  | { outcome: 'KERNEL_REJECTION' | 'APPLICATION_REJECTION' | 'PERSISTENCE_FAILURE'; error: { code: string } };
export interface Session { role: Role; token: string; expiresAt: number }

let session: Session | null = null;
let selectedRole: Role | null = null;
const roleListeners = new Set<(role: Role | null) => void>();

export function currentSession(): Session | null {
  if (session && session.expiresAt <= Date.now()) session = null;
  return session;
}

export function currentRole(): Role | null {
  return selectedRole;
}

export function subscribeToRole(listener: (role: Role | null) => void): () => void {
  roleListeners.add(listener);
  return () => roleListeners.delete(listener);
}

export async function switchRole(role: Role): Promise<Session> {
  session = null;
  selectedRole = role;
  return requestRoleToken(role);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let active = currentSession();
  if (!active) {
    if (selectedRole === null) throw new ApiError('UNAUTHENTICATED', 401);
    active = await requestRoleToken(selectedRole);
  }
  const send = (token: string) => fetch(`/api${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers, authorization: `Bearer ${token}` },
  });
  let response = await send(active.token);
  if (response.status === 401) {
    active = await requestRoleToken(active.role);
    response = await send(active.token);
  }
  if (!response.ok) throw new ApiError(await readCode(response), response.status);
  return response.json() as Promise<T>;
}

async function requestRoleToken(role: Role): Promise<Session> {
  try {
    const response = await fetch('/api/development/auth/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!response.ok) throw new ApiError(await readCode(response), response.status);
    const result = await response.json() as TokenResponse;
    session = { role, token: result.token, expiresAt: Date.now() + result.expiresIn * 1000 };
    selectedRole = role;
    publishRole(role);
    return session;
  } catch (error) {
    session = null;
    selectedRole = null;
    publishRole(null);
    throw error;
  }
}

function publishRole(role: Role | null): void {
  for (const listener of roleListeners) listener(role);
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

export function userMessage(error: unknown): string {
  if (error instanceof AmountInputError) return 'Geçerli bir TRY tutarı girin (en fazla iki ondalık basamak).';
  if (error instanceof ApiError) {
    if (error.status === 401 || error.code === 'UNAUTHENTICATED') return 'Oturum doğrulanamadı. Lütfen rolünüzü yeniden seçin.';
    if (error.status === 403 || ['FORBIDDEN', 'COMMAND_NOT_PERMITTED', 'AUTHORIZATION_DENIED', 'PRINCIPAL_DISABLED'].includes(error.code)) {
      return 'Bu işlem için yetkiniz yok.';
    }
    if (error.status === 404 || ['NOT_FOUND', 'CELL_NOT_FOUND'].includes(error.code)) return 'Anlaşma bulunamadı.';
    if (error.status === 409 || ['IDEMPOTENCY_CONFLICT', 'FUNDING_RECEIPT_CONFLICT', 'FUNDING_DISPUTE_BLOCKED'].includes(error.code)) {
      return error.code === 'IDEMPOTENCY_CONFLICT'
        ? 'İstek başka bir işlemle çakıştı. Lütfen sayfayı yenileyip tekrar deneyin.'
        : 'Anlaşmanın mevcut durumu bu işleme izin vermiyor.';
    }
    if (error.status === 429 || error.code === 'RATE_LIMITED') return 'Çok fazla istek gönderildi. Lütfen biraz bekleyip tekrar deneyin.';
    if (error.status >= 500 || ['BACKEND_UNAVAILABLE', 'RUNTIME_UNAVAILABLE', 'UNAVAILABLE',
      'RATE_LIMIT_UNAVAILABLE', 'FUNDING_DEPENDENCY_UNAVAILABLE'].includes(error.code)) {
      return 'Hizmet şu anda kullanılamıyor. Lütfen daha sonra tekrar deneyin.';
    }
    if (error.status === 400 || error.status === 422 || ['INVALID_INPUT', 'INVALID_COMMAND', 'INVALID_REQUEST',
      'FUNDING_NOT_FINAL'].includes(error.code)) return 'Bilgiler geçersiz veya işlem şu an için uygun değil. Lütfen kontrol edin.';
  }
  if (error instanceof TypeError) return 'Hizmete bağlanılamadı. Bağlantınızı kontrol edip tekrar deneyin.';
  return 'İşlem tamamlanamadı. Lütfen tekrar deneyin.';
}

export async function getCells(): Promise<CellSummary[]> {
  return (await api<{ cells: CellSummary[] }>('/cells')).cells;
}

export async function getCell(cellId: string): Promise<CellState> {
  return (await api<{ cell: { state: CellState } }>('/cells/' + encodeURIComponent(cellId))).cell.state;
}

export async function createCell(input: { payee: string; amountTry: string; description: string }): Promise<CommandResponse & { cellId: string }> {
  if (selectedRole !== 'payer') throw new ApiError('COMMAND_NOT_PERMITTED', 403);
  if (input.payee !== DEVELOPMENT_PAYEE_ID) throw new ApiError('INVALID_INPUT', 400);
  const cellId = crypto.randomUUID();
  const amount = tryAmountToKurus(input.amountTry);
  const result = await api<CommandResponse>('/commands', { method: 'POST', body: JSON.stringify({ command: {
    commandId: crypto.randomUUID(), cellId, type: 'CreateCell',
    payload: { payer: DEVELOPMENT_PAYER_ID, payee: DEVELOPMENT_PAYEE_ID, amount,
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
  return command(cellId, 'RequestRelease', { requestedBy: selectedRole === 'payer' ? 'development-payer' : 'development-payee' });
}

export function approveRelease(cellId: string): Promise<CommandResponse> {
  return command(cellId, 'ApproveRelease', { approvedBy: selectedRole === 'payer' ? 'development-payer' : 'development-payee' });
}

function command(cellId: string, type: string, payload: Record<string, string>): Promise<CommandResponse> {
  return api('/commands', { method: 'POST', body: JSON.stringify({ command: {
    commandId: crypto.randomUUID(), cellId, type, payload,
  } }) });
}
