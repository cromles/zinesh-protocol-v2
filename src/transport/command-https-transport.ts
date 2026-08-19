import { readFile, stat } from 'fs/promises';
import { createServer as createHttpsServer } from 'https';
import { isIP } from 'net';
import { createPrivateKey, X509Certificate } from 'crypto';
import type { IncomingMessage } from 'http';
import { createSecureContext } from 'tls';
import type { SecureVersion } from 'tls';
import {
  CommandHttpTransport,
} from './command-http-transport';
import type {
  CommandDispatcher, CommandHttpConfig, TransportAuditSink,
} from './command-http-transport';
import type { RateLimiter } from '../security/rate-limiter';
import { noOpSecurityTelemetry, serverCorrelationId } from '../security/security-observability';
import type { SecurityTelemetry } from '../security/security-observability';

export interface CommandHttpsConfig extends CommandHttpConfig {
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly minimumTlsVersion: 'TLSv1.2' | 'TLSv1.3';
  readonly allowedHosts: readonly string[];
  readonly trustedProxies: readonly string[];
}

export class TlsConfigurationError extends Error {
  constructor() {
    super('Invalid TLS configuration');
    this.name = 'TlsConfigurationError';
  }
}

export class CommandHttpsTransport {
  private constructor(private readonly transport: CommandHttpTransport) {}

  static async create(
    dispatcher: CommandDispatcher,
    config: CommandHttpsConfig,
    audit?: TransportAuditSink,
    now: Date = new Date(),
    preAuthenticationRateLimiter?: RateLimiter,
    telemetry: SecurityTelemetry = noOpSecurityTelemetry,
  ): Promise<CommandHttpsTransport> {
    let material: Awaited<ReturnType<typeof loadAndValidateTlsMaterial>>;
    try {
      material = await loadAndValidateTlsMaterial(config, now);
    } catch (error) {
      telemetry.record({
        category: 'TLS', action: 'CONFIGURATION', outcome: 'REJECTED',
        reason: 'TLS_CONFIGURATION_REJECTED', correlationId: serverCorrelationId(),
      });
      throw error;
    }
    const admission = createPublicIngressAdmission(config);
    const transport = new CommandHttpTransport(
      dispatcher,
      config,
      audit,
      undefined,
      (handler) => {
        const server = createHttpsServer({
          cert: material.certificate,
          key: material.privateKey,
          minVersion: config.minimumTlsVersion as SecureVersion,
          maxHeaderSize: config.maxHeaderBytes,
        }, handler);
        server.on('tlsClientError', () => telemetry.record({
          category: 'TLS', action: 'HANDSHAKE', outcome: 'REJECTED',
          reason: 'TLS_REJECTION', correlationId: serverCorrelationId(),
        }));
        return server;
      },
      admission,
      preAuthenticationRateLimiter,
      telemetry,
    );
    return new CommandHttpsTransport(transport);
  }

  listen(): Promise<void> { return this.transport.listen(); }
  close(): Promise<void> { return this.transport.close(); }
  address(): { readonly address: string; readonly port: number } | null { return this.transport.address(); }
}

async function loadAndValidateTlsMaterial(
  config: CommandHttpsConfig,
  now: Date,
): Promise<{ readonly certificate: Buffer; readonly privateKey: Buffer }> {
  try {
    const [certificate, privateKey, privateKeyStat] = await Promise.all([
      readFile(config.certificatePath), readFile(config.privateKeyPath), stat(config.privateKeyPath),
    ]);
    const parsedCertificate = new X509Certificate(certificate);
    const parsedPrivateKey = createPrivateKey(privateKey);
    const validFrom = Date.parse(parsedCertificate.validFrom);
    const validTo = Date.parse(parsedCertificate.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)
      || now.getTime() < validFrom || now.getTime() >= validTo
      || !parsedCertificate.checkPrivateKey(parsedPrivateKey)
      || !config.allowedHosts.every((host) => isIP(host) === 0
        ? parsedCertificate.checkHost(host) !== undefined
        : parsedCertificate.checkIP(host) !== undefined)
      || !privateKeyStat.isFile()
      || (process.platform !== 'win32' && (privateKeyStat.mode & 0o077) !== 0)) {
      throw new TlsConfigurationError();
    }
    createSecureContext({
      cert: certificate,
      key: privateKey,
      minVersion: config.minimumTlsVersion as SecureVersion,
    });
    return { certificate, privateKey };
  } catch {
    throw new TlsConfigurationError();
  }
}

function createPublicIngressAdmission(config: CommandHttpsConfig) {
  const trustedProxies = new Set(config.trustedProxies.map(normalizeAddress));
  const allowedHosts = new Set(config.allowedHosts.map((host) => host.toLowerCase()));
  return (request: IncomingMessage):
    { readonly ok: true; readonly networkSource: string } |
    { readonly ok: false; readonly status: number; readonly code: string } => {
    if (!('encrypted' in request.socket) || request.socket.encrypted !== true) {
      return { ok: false, status: 400, code: 'HTTPS_REQUIRED' };
    }
    const host = normalizedHost(request.headers.host);
    if (host === null || !allowedHosts.has(host)) {
      return { ok: false, status: 421, code: 'UNTRUSTED_HOST' };
    }
    const forwarding = forwardingHeaders(request);
    const remoteAddress = normalizeAddress(request.socket.remoteAddress ?? '');
    if (forwarding.length === 0) return { ok: true, networkSource: remoteAddress };
    if (!trustedProxies.has(remoteAddress) || !validForwarding(request, allowedHosts)) {
      return { ok: false, status: 403, code: 'UNTRUSTED_FORWARDING' };
    }
    return { ok: true, networkSource: forwardedClientSource(request) ?? remoteAddress };
  };
}

const FORWARDING_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-proto',
  'x-forwarded-host', 'x-real-ip',
] as const;

function forwardingHeaders(request: IncomingMessage): string[] {
  return FORWARDING_HEADERS.filter((name) => request.headers[name] !== undefined);
}

function validForwarding(request: IncomingMessage, allowedHosts: ReadonlySet<string>): boolean {
  const forwarded = singleHeader(request.headers.forwarded);
  const forwardedFor = singleHeader(request.headers['x-forwarded-for']);
  const forwardedProto = singleHeader(request.headers['x-forwarded-proto']);
  const forwardedHost = singleHeader(request.headers['x-forwarded-host']);
  const realIp = singleHeader(request.headers['x-real-ip']);
  if ([request.headers.forwarded, request.headers['x-forwarded-for'], request.headers['x-forwarded-proto'],
    request.headers['x-forwarded-host'], request.headers['x-real-ip']]
    .some((value) => Array.isArray(value))) return false;
  if (forwardedProto !== null && forwardedProto.toLowerCase() !== 'https') return false;
  if (forwardedFor !== null && (!singleHop(forwardedFor) || isIP(unquoteAddress(forwardedFor)) === 0)) return false;
  if (realIp !== null && (!singleHop(realIp) || isIP(unquoteAddress(realIp)) === 0)) return false;
  if (forwardedFor !== null && realIp !== null
    && normalizeAddress(unquoteAddress(forwardedFor)) !== normalizeAddress(unquoteAddress(realIp))) return false;
  if (forwardedHost !== null) {
    const host = normalizedHost(forwardedHost);
    if (host === null || !allowedHosts.has(host)) return false;
  }
  if (forwarded !== null && !validStandardForwarded(forwarded, allowedHosts)) return false;
  const sources = [forwardedFor, realIp, forwarded === null ? null : standardForwardedSource(forwarded)]
    .filter((value): value is string => value !== null)
    .map((value) => normalizeAddress(unquoteAddress(value)));
  return new Set(sources).size <= 1;
}

function validStandardForwarded(value: string, allowedHosts: ReadonlySet<string>): boolean {
  if (!singleHop(value)) return false;
  const entries = value.split(';').map((entry) => entry.trim());
  const parsed = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) return false;
    const key = entry.slice(0, separator).toLowerCase();
    const child = entry.slice(separator + 1).replace(/^"|"$/g, '');
    if (!['for', 'proto', 'host'].includes(key) || parsed.has(key) || child.length === 0) return false;
    parsed.set(key, child);
  }
  const address = parsed.get('for');
  const proto = parsed.get('proto');
  const hostValue = parsed.get('host');
  if (address === undefined || isIP(unquoteAddress(address)) === 0 || proto?.toLowerCase() !== 'https') return false;
  if (hostValue !== undefined) {
    const host = normalizedHost(hostValue);
    if (host === null || !allowedHosts.has(host)) return false;
  }
  return true;
}

function forwardedClientSource(request: IncomingMessage): string | null {
  const forwardedFor = singleHeader(request.headers['x-forwarded-for']);
  if (forwardedFor !== null) return normalizeAddress(unquoteAddress(forwardedFor));
  const forwarded = singleHeader(request.headers.forwarded);
  if (forwarded !== null) return normalizeAddress(unquoteAddress(standardForwardedSource(forwarded) ?? ''));
  const realIp = singleHeader(request.headers['x-real-ip']);
  return realIp === null ? null : normalizeAddress(unquoteAddress(realIp));
}

function standardForwardedSource(value: string): string | null {
  for (const entry of value.split(';')) {
    const separator = entry.indexOf('=');
    if (separator > 0 && entry.slice(0, separator).trim().toLowerCase() === 'for')
      return entry.slice(separator + 1).trim();
  }
  return null;
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function singleHop(value: string): boolean { return !value.includes(',') && value.length <= 512; }

function unquoteAddress(value: string): string {
  const unquoted = value.replace(/^"|"$/g, '');
  if (unquoted.startsWith('[') && unquoted.endsWith(']')) return unquoted.slice(1, -1);
  return unquoted;
}

function normalizeAddress(value: string): string {
  const unwrapped = unquoteAddress(value).toLowerCase();
  if (unwrapped.startsWith('::ffff:') && isIP(unwrapped.slice(7)) === 4) return unwrapped.slice(7);
  if (isIP(unwrapped) !== 6) return unwrapped;
  const halves = unwrapped.split('::');
  const left = halves[0] === '' ? [] : halves[0]!.split(':');
  const right = halves.length < 2 || halves[1] === '' ? [] : halves[1]!.split(':');
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return groups.map((group) => Number.parseInt(group, 16).toString(16)).join(':');
}

function normalizedHost(value: string | undefined): string | null {
  if (value === undefined || value.length === 0 || value.length > 253 || value.includes(',')) return null;
  const lower = value.toLowerCase();
  if (lower.startsWith('[')) {
    const close = lower.indexOf(']');
    if (close < 0 || (close + 1 < lower.length && !/^:\d{1,5}$/.test(lower.slice(close + 1)))) return null;
    const address = lower.slice(1, close);
    return isIP(address) === 6 ? address : null;
  }
  const colon = lower.lastIndexOf(':');
  const host = colon > -1 ? lower.slice(0, colon) : lower;
  if (colon > -1 && !/^\d{1,5}$/.test(lower.slice(colon + 1))) return null;
  return isIP(host) !== 0 || /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : null;
}
