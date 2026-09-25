import { createServer } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import type { CommandServerFactory } from '../transport/command-http-transport';
import {
  DevelopmentIdentityIssuer,
  DEVELOPMENT_IDENTITY_TTL_SECONDS,
} from './development-identity-issuer';

export const DEVELOPMENT_TOKEN_PATH = '/development/auth/token';
export const DEVELOPMENT_BROWSER_ORIGIN = 'http://localhost:5173';
const MAX_TOKEN_REQUEST_BYTES = 1_024;

/**
 * Adds the development browser-token route around the normal command handler.
 * This factory is compiled only by tsconfig.development.json.
 */
export function createDevelopmentHttpServerFactory(
  issuer: DevelopmentIdentityIssuer,
  allowedBrowserOrigin: string,
  maxHeaderBytes: number,
): CommandServerFactory {
  return (commandHandler) => createServer({ maxHeaderSize: maxHeaderBytes }, (request, response) => {
    if (request.url !== DEVELOPMENT_TOKEN_PATH) {
      commandHandler(request, response);
      return;
    }
    void handleTokenRequest(request, response, issuer, allowedBrowserOrigin);
  });
}

async function handleTokenRequest(
  request: IncomingMessage,
  response: ServerResponse,
  issuer: DevelopmentIdentityIssuer,
  allowedBrowserOrigin: string,
): Promise<void> {
  secureTokenResponse(response);
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    respond(response, 403, 'LOOPBACK_ONLY');
    request.resume();
    return;
  }
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    respond(response, 405, 'METHOD_NOT_ALLOWED');
    request.resume();
    return;
  }
  if (request.headers.origin !== allowedBrowserOrigin) {
    respond(response, 403, 'ORIGIN_NOT_ALLOWED');
    request.resume();
    return;
  }
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    respond(response, 415, 'UNSUPPORTED_MEDIA_TYPE');
    request.resume();
    return;
  }

  const declaredBytes = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_TOKEN_REQUEST_BYTES) {
    respond(response, 413, 'REQUEST_TOO_LARGE');
    request.resume();
    return;
  }

  let raw: string;
  try {
    raw = await readBody(request);
  } catch (error) {
    respond(response, error instanceof TokenRequestTooLargeError ? 413 : 400,
      error instanceof TokenRequestTooLargeError ? 'REQUEST_TOO_LARGE' : 'INVALID_REQUEST');
    return;
  }

  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { respond(response, 400, 'INVALID_REQUEST'); return; }
  if (!isRoleRequest(value)) { respond(response, 400, 'INVALID_ROLE'); return; }

  const identity = value.role === 'payer' ? 'PAYER' : 'PAYEE';
  const token = issuer.issue(identity);
  response.statusCode = 200;
  response.end(JSON.stringify({ token, expiresIn: DEVELOPMENT_IDENTITY_TTL_SECONDS, role: value.role }));
}

function secureTokenResponse(response: ServerResponse): void {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store, max-age=0');
  response.setHeader('pragma', 'no-cache');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
}

function respond(response: ServerResponse, status: number, code: string): void {
  response.statusCode = status;
  response.end(JSON.stringify({ error: { code } }));
}

function isRoleRequest(value: unknown): value is { readonly role: 'payer' | 'payee' } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && (record['role'] === 'payer' || record['role'] === 'payee');
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

class TokenRequestTooLargeError extends Error {}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_TOKEN_REQUEST_BYTES) throw new TokenRequestTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
