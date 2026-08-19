import { createServer } from 'http';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import type { Command } from '../core/types';
import {
  makeActorId, makeAmount, makeCellId, makeCommandId, makeTimestamp,
} from '../core/types';
import type { HandleCommandResult } from '../application/types';
import type { ExternalCommandRequest } from '../security/trusted-ingress';
import type { RateLimiter } from '../security/rate-limiter';

export interface CommandDispatcher {
  handleCommand(request: ExternalCommandRequest): Promise<HandleCommandResult>;
}

export interface TransportAuditRecord {
  readonly correlationId: string;
  readonly commandId?: string;
  readonly commandType?: string;
  readonly outcome: string;
  readonly durationMs: number;
}

export interface TransportAuditSink { record(entry: TransportAuditRecord): void }

export class JsonLineTransportAuditSink implements TransportAuditSink {
  record(entry: TransportAuditRecord): void {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}

export interface CommandHttpConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly maxHeaderBytes: number;
  readonly requestTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly maxConcurrentRequests?: number;
}

export type CommandServerFactory = (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) => Server;

export type CommandRequestAdmission = (
  request: IncomingMessage,
) => { readonly ok: true; readonly networkSource?: string } |
  { readonly ok: false; readonly status: number; readonly code: string };

export class CommandHttpTransport {
  private readonly server: Server;
  private activeRequests = 0;

  constructor(
    private readonly dispatcher: CommandDispatcher,
    private readonly config: CommandHttpConfig,
    private readonly audit: TransportAuditSink = new JsonLineTransportAuditSink(),
    private readonly correlationId: () => string = randomUUID,
    serverFactory: CommandServerFactory = (handler) => createServer(
      { maxHeaderSize: config.maxHeaderBytes }, handler,
    ),
    private readonly admission: CommandRequestAdmission = () => ({ ok: true }),
    private readonly preAuthenticationRateLimiter?: RateLimiter,
  ) {
    this.server = serverFactory((request, response) => {
      void this.route(request, response);
    });
    this.server.requestTimeout = config.requestTimeoutMs;
    this.server.headersTimeout = config.headersTimeoutMs;
    this.server.keepAliveTimeout = 5_000;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server.listening) { resolve(); return; }
      this.server.close((error) => error === undefined ? resolve() : reject(error));
      this.server.closeIdleConnections();
    });
  }

  address(): { readonly address: string; readonly port: number } | null {
    const address = this.server.address();
    return typeof address === 'object' && address !== null
      ? { address: address.address, port: address.port } : null;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const correlationId = validCorrelationId(request.headers['x-correlation-id']) ?? this.correlationId();
    response.setHeader('x-correlation-id', correlationId);
    applySecurityHeaders(response);
    let commandId: string | undefined;
    let commandType: string | undefined;
    let outcome = 'INTERNAL_FAILURE';
    let acquiredRequestSlot = false;
    try {
      const admitted = this.admission(request);
      if (!admitted.ok) {
        outcome = admitted.code;
        this.respond(response, admitted.status, { error: { code: admitted.code } });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/commands') {
        outcome = 'NOT_FOUND'; this.respond(response, 404, { error: { code: 'NOT_FOUND' } }); return;
      }
      const maximumConcurrent = this.config.maxConcurrentRequests ?? Number.MAX_SAFE_INTEGER;
      if (this.activeRequests >= maximumConcurrent) {
        outcome = 'RATE_LIMITED'; this.retryAfter(response, 1);
        this.respond(response, 429, { error: { code: 'RATE_LIMITED' } }); return;
      }
      this.activeRequests += 1;
      acquiredRequestSlot = true;
      if (this.preAuthenticationRateLimiter !== undefined) {
        const networkSource = admitted.networkSource ?? normalizePeer(request.socket.remoteAddress ?? 'unknown');
        try {
          const decision = await this.preAuthenticationRateLimiter.consume(networkSource);
          if (!decision.allowed) {
            outcome = 'RATE_LIMITED'; this.retryAfter(response, decision.retryAfterSeconds);
            this.respond(response, 429, { error: { code: 'RATE_LIMITED' } }); return;
          }
        } catch {
          outcome = 'RATE_LIMIT_UNAVAILABLE';
          this.respond(response, 503, { error: { code: 'RATE_LIMIT_UNAVAILABLE' } }); return;
        }
      }
      const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        outcome = 'UNSUPPORTED_MEDIA_TYPE'; this.respond(response, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE' } }); return;
      }
      const credential = bearerCredential(request.headers.authorization);
      if (credential === null) {
        outcome = 'UNAUTHENTICATED'; this.respond(response, 401, { error: { code: 'UNAUTHENTICATED' } }); return;
      }
      const raw = await readBody(request, this.config.maxBodyBytes);
      const decoded = decodeRequest(raw);
      if (!decoded.ok) {
        outcome = decoded.code; this.respond(response, decoded.status, { error: { code: decoded.code } }); return;
      }
      commandId = decoded.command.commandId;
      commandType = decoded.command.type;
      const result = await this.dispatcher.handleCommand({ credential, command: decoded.command });
      outcome = result.outcome === 'SUCCESS' ? 'SUCCESS' : result.error.code;
      const mapped = mapResult(result);
      if (mapped.retryAfterSeconds !== undefined) this.retryAfter(response, mapped.retryAfterSeconds);
      this.respond(response, mapped.status, mapped.body);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        outcome = 'REQUEST_TOO_LARGE'; this.respond(response, 413, { error: { code: 'REQUEST_TOO_LARGE' } });
      } else {
        outcome = 'INTERNAL_FAILURE'; this.respond(response, 500, { error: { code: 'INTERNAL_FAILURE' } });
      }
    } finally {
      if (acquiredRequestSlot) this.activeRequests -= 1;
      const audit: TransportAuditRecord = {
        correlationId, outcome, durationMs: Math.max(0, Date.now() - started),
        ...(commandId === undefined ? {} : { commandId }),
        ...(commandType === undefined ? {} : { commandType }),
      };
      this.audit.record(audit);
    }
  }

  private retryAfter(response: ServerResponse, seconds: number): void {
    response.setHeader('retry-after', String(Math.max(1, Math.ceil(seconds))));
  }

  private respond(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent || response.destroyed) return;
    response.statusCode = status;
    response.end(JSON.stringify(body, jsonReplacer));
  }
}

class BodyTooLargeError extends Error {}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limit) { request.destroy(); throw new BodyTooLargeError(); }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type DecodeResult =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly status: number; readonly code: string };

function decodeRequest(raw: string): DecodeResult {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return bad('MALFORMED_JSON'); }
  if (!plainObject(value) || Object.keys(value).some((key) => key !== 'command') || !plainObject(value.command)) {
    return bad('INVALID_REQUEST');
  }
  const input = value.command;
  if (Object.keys(input).some((key) => !['commandId', 'cellId', 'type', 'payload'].includes(key))) return bad('INVALID_REQUEST');
  if (!boundedString(input.commandId, 128)) return bad('MISSING_COMMAND_ID');
  if (!boundedString(input.cellId, 128) || !boundedString(input.type, 64) || !plainObject(input.payload)) return bad('INVALID_COMMAND');
  const supported = new Set([
    'CreateCell','FundCell','RequestRelease','ApproveRelease','RequestRefund',
    'ApproveRefund','ForceRefund','ExpireCell','OpenDispute','ResolveDispute',
  ]);
  if (!supported.has(input.type)) return bad('UNSUPPORTED_COMMAND');
  if (!safeTree(input.payload, 0)) return bad('INVALID_COMMAND');
  try {
    const payload = decodePayload(input.type, input.payload);
    return { ok: true, command: {
      commandId: makeCommandId(input.commandId), cellId: makeCellId(input.cellId),
      type: input.type as Command['type'], payload: payload as unknown as Command['payload'],
    } };
  } catch { return bad('INVALID_COMMAND'); }
}

function decodePayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const result = { ...payload };
  if ('amount' in result) {
    if (typeof result.amount !== 'string' || !/^[1-9][0-9]{0,30}$/.test(result.amount)) throw new Error();
    result.amount = makeAmount(BigInt(result.amount));
  }
  for (const field of ['fundingDeadline','completionDeadline','currentTime']) {
    if (field in result) {
      if (typeof result[field] !== 'number') throw new Error();
      result[field] = makeTimestamp(result[field]);
    }
  }
  for (const field of ['payer','payee','arbiter','funderId','requestedBy','approvedBy','triggeredBy','openedBy','resolvedBy']) {
    if (field in result) {
      if (!boundedString(result[field], 128)) throw new Error();
      result[field] = makeActorId(result[field]);
    }
  }
  if (type === 'CreateCell' && result.currency !== 'TRY') throw new Error();
  return result;
}

function mapResult(result: HandleCommandResult): { status: number; body: unknown; retryAfterSeconds?: number } {
  if (result.outcome === 'SUCCESS') return { status: 200, body: result };
  if (result.outcome === 'KERNEL_REJECTION') {
    const status = result.error.code === 'AUTHORIZATION_DENIED' ? 403 : 422;
    return { status, body: { outcome: result.outcome, error: { code: result.error.code } } };
  }
  const code = result.error.code;
  const status = code === 'UNAUTHENTICATED' ? 401
    : code === 'IDEMPOTENCY_CONFLICT' ? 409
    : code === 'RATE_LIMITED' ? 429
    : code === 'RATE_LIMIT_UNAVAILABLE' ? 503
    : code === 'INVALID_INPUT' ? 400
    : result.outcome === 'PERSISTENCE_FAILURE' ? 503 : 403;
  return { status, body: { outcome: result.outcome, error: { code } },
    ...(result.error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: result.error.retryAfterSeconds }) };
}

function bad(code: string): DecodeResult { return { ok: false, status: 400, code }; }
function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function safeTree(value: unknown, depth: number): boolean {
  if (depth > 4) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value === 'string') return value.length <= 256;
  if (Array.isArray(value)) return value.length <= 16 && value.every((item) => safeTree(item, depth + 1));
  return plainObject(value) && Object.keys(value).length <= 16 && Object.entries(value).every(([key, child]) =>
    key.length <= 64 && safeTree(child, depth + 1));
}
function bearerCredential(value: string | undefined): string | null {
  if (value === undefined || value.length > 20_000) return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
  return match?.[1] ?? null;
}
function validCorrelationId(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}
function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('pragma', 'no-cache');
  response.setHeader('x-content-type-options', 'nosniff');
}
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
function normalizePeer(value: string): string { return value.startsWith('::ffff:') ? value.slice(7) : value; }
