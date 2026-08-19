/**
 * ZINESH PROTOCOL V2 — Composition Root
 *
 * Process wiring only: environment, construction, connect, signals, shutdown.
 * Not a domain layer. Not a transport. Not a migration runner.
 */

import { PostgresPersistenceAdapter } from '../adapters/postgres-persistence-adapter';
import type { PostgresConfig } from '../adapters/postgres-persistence-adapter';
import { CellApplication } from '../application/cell-application';
import { systemClock } from '../application/clock';
import { createEventIdFactory } from '../application/event-id-factory';
import type { HandleCommandResult } from '../application/types';
import { cellKernel } from '../kernel';
import {
  TrustedCommandIngress,
  failClosedAuthentication,
  rejectAllFundingEvidence,
} from '../security/trusted-ingress';
import type {
  AuthenticationPort,
  ExternalCommandRequest,
  FundingEvidencePort,
  PrincipalAuthority,
} from '../security/trusted-ingress';
import {
  CachedJwksProvider, HttpJwksFetcher, JwtAuthenticationAdapter,
} from '../security/jwt-authentication';
import type { JwtAuthenticationConfig } from '../security/jwt-authentication';
import { JsonLineTransportAuditSink } from '../transport/command-http-transport';
import type { CommandHttpConfig } from '../transport/command-http-transport';
import { CommandHttpsTransport } from '../transport/command-https-transport';
import type { CommandHttpsConfig } from '../transport/command-https-transport';
import { isIP } from 'net';
import { PostgresFixedWindowRateLimiter } from '../adapters/postgres-rate-limit-store';
import { allowAllRateLimiter } from '../security/rate-limiter';
import type { RateLimiter, RateLimitPolicy } from '../security/rate-limiter';
import {
  JsonLineSecurityAlertSink, JsonLineSecurityLogSink, JsonLineSecurityMetricSink,
  SecurityTelemetry, noOpSecurityTelemetry,
} from '../security/security-observability';
import type {
  SecurityAlertThresholds, TelemetryRetentionPolicy,
} from '../security/security-observability';

/** Operational shutdown bound. Not a domain rule. Not configurable. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

const REQUIRED_VARS = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'] as const;

export class ConfigurationError extends Error {
  readonly variable: string;

  constructor(variable: string, detail: string) {
    super(`Invalid configuration: ${variable} ${detail}`);
    this.name = 'ConfigurationError';
    this.variable = variable;
  }
}

export class RuntimeUnavailableError extends Error {
  constructor() {
    super('Runtime is shutting down');
    this.name = 'RuntimeUnavailableError';
  }
}

export type EnvMap = NodeJS.ProcessEnv;

export function loadPostgresConfig(env: EnvMap): PostgresConfig {
  const host = requiredNonEmpty(env, 'PGHOST');
  const port = requiredPort(env, 'PGPORT');
  const database = requiredNonEmpty(env, 'PGDATABASE');
  const user = requiredNonEmpty(env, 'PGUSER');
  const password = requiredPassword(env, 'PGPASSWORD');

  return { host, port, database, user, password };
}

export function loadAuthenticationConfig(env: EnvMap): JwtAuthenticationConfig {
  const issuer = requiredSecurityValue(env, 'AUTH_TRUSTED_ISSUER');
  if (!issuer.startsWith('https://')) throw new ConfigurationError('AUTH_TRUSTED_ISSUER', 'must use https');
  const audience = requiredSecurityValue(env, 'AUTH_TRUSTED_AUDIENCE');
  const jwksUrl = requiredSecurityValue(env, 'AUTH_JWKS_URL');
  if (!jwksUrl.startsWith('https://')) throw new ConfigurationError('AUTH_JWKS_URL', 'must use https');
  const algorithm = requiredSecurityValue(env, 'AUTH_ALLOWED_ALGORITHM');
  if (algorithm !== 'RS256') throw new ConfigurationError('AUTH_ALLOWED_ALGORITHM', 'must be RS256');
  const clockSkewSeconds = requiredSecurityInteger(env, 'AUTH_CLOCK_SKEW_SECONDS', 0, 300);
  const jwksCacheTtlMs = requiredSecurityInteger(env, 'AUTH_JWKS_CACHE_TTL_MS', 1_000, 86_400_000);
  const jwksTimeoutMs = requiredSecurityInteger(env, 'AUTH_JWKS_TIMEOUT_MS', 100, 30_000);
  return {
    issuers: [{ issuer, audiences: [audience], algorithms: ['RS256'], jwksUrl }],
    clockSkewSeconds, jwksCacheTtlMs, jwksTimeoutMs,
  };
}

export function loadTransportConfig(env: EnvMap): CommandHttpConfig {
  const host = requiredSecurityValue(env, 'HTTP_HOST');
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new ConfigurationError('HTTP_HOST', 'must be a loopback address until trusted TLS termination is configured');
  }
  const port = requiredSecurityInteger(env, 'HTTP_PORT', 1, 65535);
  const maxBodyBytes = requiredSecurityInteger(env, 'HTTP_MAX_BODY_BYTES', 1_024, 1_048_576);
  const maxHeaderBytes = requiredSecurityInteger(env, 'HTTP_MAX_HEADER_BYTES', 1_024, 65_536);
  const requestTimeoutMs = requiredSecurityInteger(env, 'HTTP_REQUEST_TIMEOUT_MS', 100, 120_000);
  const headersTimeoutMs = requiredSecurityInteger(env, 'HTTP_HEADERS_TIMEOUT_MS', 100, requestTimeoutMs);
  const maxConcurrentRequests = requiredSecurityInteger(env, 'HTTP_MAX_CONCURRENT_REQUESTS', 1, 100_000);
  return { host, port, maxBodyBytes, maxHeaderBytes, requestTimeoutMs, headersTimeoutMs, maxConcurrentRequests };
}

export interface RateLimitingConfig {
  readonly preAuth: RateLimitPolicy;
  readonly principal: RateLimitPolicy;
}

export interface SecurityObservabilityConfig {
  readonly instanceId: string;
  readonly retention: TelemetryRetentionPolicy;
  readonly thresholds: SecurityAlertThresholds;
}

export function loadSecurityObservabilityConfig(env: EnvMap): SecurityObservabilityConfig {
  return {
    instanceId: requiredBoundedIdentity(env, 'OBSERVABILITY_INSTANCE_ID'),
    retention: {
      securityLogDays: requiredSecurityInteger(env, 'SECURITY_LOG_RETENTION_DAYS', 1, 3_650),
      metricDays: requiredSecurityInteger(env, 'SECURITY_METRIC_RETENTION_DAYS', 1, 3_650),
      securityAuditDays: requiredSecurityInteger(env, 'SECURITY_AUDIT_RETENTION_DAYS', 1, 3_650),
    },
    thresholds: {
      windowMs: requiredSecurityInteger(env, 'SECURITY_ALERT_WINDOW_MS', 1_000, 86_400_000),
      authenticationFailures: requiredSecurityInteger(env, 'SECURITY_ALERT_AUTH_FAILURES', 1, 1_000_000),
      rateLimitRejections: requiredSecurityInteger(env, 'SECURITY_ALERT_RATE_LIMIT_REJECTIONS', 1, 1_000_000),
      authenticationDependencyFailures: requiredSecurityInteger(env, 'SECURITY_ALERT_AUTH_DEPENDENCY_FAILURES', 1, 1_000_000),
      authorizationRejections: requiredSecurityInteger(env, 'SECURITY_ALERT_AUTHORIZATION_REJECTIONS', 1, 1_000_000),
      disabledPrincipalAttempts: requiredSecurityInteger(env, 'SECURITY_ALERT_DISABLED_PRINCIPAL_ATTEMPTS', 1, 1_000_000),
      postgresFailures: requiredSecurityInteger(env, 'SECURITY_ALERT_POSTGRES_FAILURES', 1, 1_000_000),
      failClosedDecisions: requiredSecurityInteger(env, 'SECURITY_ALERT_FAIL_CLOSED', 1, 1_000_000),
      telemetryFailures: requiredSecurityInteger(env, 'SECURITY_ALERT_TELEMETRY_FAILURES', 1, 1_000_000),
    },
  };
}

export function createProductionSecurityTelemetry(config: SecurityObservabilityConfig): SecurityTelemetry {
  return new SecurityTelemetry({
    instanceId: config.instanceId,
    log: new JsonLineSecurityLogSink(),
    metrics: new JsonLineSecurityMetricSink(),
    alerts: new JsonLineSecurityAlertSink(),
    thresholds: config.thresholds,
    retention: config.retention,
  });
}

export function loadRateLimitingConfig(env: EnvMap): RateLimitingConfig {
  const preAuthLimit = requiredSecurityInteger(env, 'RATE_LIMIT_PRE_AUTH_LIMIT', 1, 1_000_000);
  const principalLimit = requiredSecurityInteger(env, 'RATE_LIMIT_PRINCIPAL_LIMIT', 1, 1_000_000);
  const preAuthWindowMs = requiredSecurityInteger(env, 'RATE_LIMIT_PRE_AUTH_WINDOW_MS', 1_000, 86_400_000);
  const principalWindowMs = requiredSecurityInteger(env, 'RATE_LIMIT_PRINCIPAL_WINDOW_MS', 1_000, 86_400_000);
  const retentionMs = requiredSecurityInteger(env, 'RATE_LIMIT_RETENTION_MS', 1_000, 604_800_000);
  if (retentionMs < Math.max(preAuthWindowMs, principalWindowMs)) {
    throw new ConfigurationError('RATE_LIMIT_RETENTION_MS', 'must cover both active windows');
  }
  const storageTimeoutMs = requiredSecurityInteger(env, 'RATE_LIMIT_STORAGE_TIMEOUT_MS', 50, 30_000);
  return {
    preAuth: { limit: preAuthLimit, windowMs: preAuthWindowMs, retentionMs, storageTimeoutMs },
    principal: { limit: principalLimit, windowMs: principalWindowMs, retentionMs, storageTimeoutMs },
  };
}

export function loadPublicIngressConfig(env: EnvMap): CommandHttpsConfig {
  const host = requiredSecurityValue(env, 'HTTPS_HOST');
  if (isIP(host) === 0) throw new ConfigurationError('HTTPS_HOST', 'must be an explicit IP address');
  const port = requiredSecurityInteger(env, 'HTTPS_PORT', 1, 65535);
  const maxBodyBytes = requiredSecurityInteger(env, 'HTTP_MAX_BODY_BYTES', 1_024, 1_048_576);
  const maxHeaderBytes = requiredSecurityInteger(env, 'HTTP_MAX_HEADER_BYTES', 1_024, 65_536);
  const requestTimeoutMs = requiredSecurityInteger(env, 'HTTP_REQUEST_TIMEOUT_MS', 100, 120_000);
  const headersTimeoutMs = requiredSecurityInteger(env, 'HTTP_HEADERS_TIMEOUT_MS', 100, requestTimeoutMs);
  const maxConcurrentRequests = requiredSecurityInteger(env, 'HTTP_MAX_CONCURRENT_REQUESTS', 1, 100_000);
  const certificatePath = requiredSecurityValue(env, 'TLS_CERTIFICATE_PATH');
  const privateKeyPath = requiredSecurityValue(env, 'TLS_PRIVATE_KEY_PATH');
  const minimumTlsVersion = requiredSecurityValue(env, 'TLS_MIN_VERSION');
  if (minimumTlsVersion !== 'TLSv1.2' && minimumTlsVersion !== 'TLSv1.3') {
    throw new ConfigurationError('TLS_MIN_VERSION', 'must be TLSv1.2 or TLSv1.3');
  }
  const allowedHosts = explicitHosts(requiredSecurityValue(env, 'TLS_ALLOWED_HOSTS'));
  const proxyValue = requiredSecurityValue(env, 'TLS_TRUSTED_PROXIES');
  const trustedProxies = proxyValue === 'NONE' ? [] : explicitProxyAddresses(proxyValue);
  return {
    host, port, maxBodyBytes, maxHeaderBytes, requestTimeoutMs, headersTimeoutMs, maxConcurrentRequests,
    certificatePath, privateKeyPath, minimumTlsVersion, allowedHosts, trustedProxies,
  };
}

function explicitHosts(value: string): string[] {
  const hosts = value.split(',').map((entry) => entry.trim().toLowerCase());
  if (hosts.length === 0 || hosts.some((host) => host.length === 0 || host === '*'
    || !(isIP(host) !== 0 || /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host)))) {
    throw new ConfigurationError('TLS_ALLOWED_HOSTS', 'must contain explicit comma-separated hosts');
  }
  return [...new Set(hosts)];
}

function explicitProxyAddresses(value: string): string[] {
  const addresses = value.split(',').map((entry) => entry.trim());
  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0
    || address === '0.0.0.0' || address === '::')) {
    throw new ConfigurationError('TLS_TRUSTED_PROXIES', 'must be NONE or explicit comma-separated IP addresses');
  }
  return [...new Set(addresses)];
}

function requiredSecurityValue(env: EnvMap, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new ConfigurationError(name, 'is required');
  return value;
}

function requiredSecurityInteger(env: EnvMap, name: string, minimum: number, maximum: number): number {
  const value = requiredSecurityValue(env, name);
  if (!/^[0-9]+$/.test(value)) throw new ConfigurationError(name, `must be an integer ${minimum}-${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(name, `must be an integer ${minimum}-${maximum}`);
  }
  return parsed;
}

function requiredBoundedIdentity(env: EnvMap, name: string): string {
  const value = requiredSecurityValue(env, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ConfigurationError(name, 'must be a bounded operational identity');
  }
  return value;
}

function readRaw(env: EnvMap, name: (typeof REQUIRED_VARS)[number]): string | undefined {
  const value = env[name];
  return value;
}

function requiredNonEmpty(env: EnvMap, name: 'PGHOST' | 'PGDATABASE' | 'PGUSER'): string {
  const value = readRaw(env, name);
  if (value === undefined) {
    throw new ConfigurationError(name, 'is required');
  }
  if (value.trim() === '') {
    throw new ConfigurationError(name, 'must be a non-empty string');
  }
  return value;
}

function requiredPassword(env: EnvMap, name: 'PGPASSWORD'): string {
  const value = readRaw(env, name);
  if (value === undefined) {
    throw new ConfigurationError(name, 'is required');
  }
  if (value === '' || value.trim() === '') {
    throw new ConfigurationError(name, 'must not be empty');
  }
  return value;
}

function requiredPort(env: EnvMap, name: 'PGPORT'): number {
  const value = readRaw(env, name);
  if (value === undefined) {
    throw new ConfigurationError(name, 'is required');
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new ConfigurationError(name, 'must be an integer 1-65535');
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError(name, 'must be an integer 1-65535');
  }
  return port;
}

/**
 * Process-unique prefix so the existing monotonic factory does not
 * collide with IDs from a previous process on UNIQUE(event_id).
 * Date.now() is allowed here only for this prefix.
 */
export function createProcessEventIdPrefix(nowMs: number = Date.now()): string {
  return `evt-${nowMs}`;
}

export interface CommandGate {
  readonly shuttingDown: boolean;
  readonly inFlight: number;
  beginShutdown(): void;
  drain(): Promise<void>;
  run<T>(work: () => Promise<T>): Promise<T>;
}

export function createCommandGate(): CommandGate {
  let shuttingDown = false;
  let inFlight = 0;
  const drainWaiters: Array<() => void> = [];

  function notifyIdle(): void {
    if (inFlight !== 0) {
      return;
    }
    while (drainWaiters.length > 0) {
      const waiter = drainWaiters.shift();
      if (waiter !== undefined) {
        waiter();
      }
    }
  }

  return {
    get shuttingDown(): boolean {
      return shuttingDown;
    },
    get inFlight(): number {
      return inFlight;
    },
    beginShutdown(): void {
      shuttingDown = true;
      notifyIdle();
    },
    drain(): Promise<void> {
      if (inFlight === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        drainWaiters.push(resolve);
      });
    },
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (shuttingDown) {
        throw new RuntimeUnavailableError();
      }
      inFlight += 1;
      try {
        return await work();
      } finally {
        inFlight -= 1;
        notifyIdle();
      }
    },
  };
}

export interface ComposedRuntime {
  readonly persistence: PostgresPersistenceAdapter;
  readonly gate: CommandGate;
  readonly preAuthenticationRateLimiter: RateLimiter;
  readonly telemetry: SecurityTelemetry;
  handleCommand(request: ExternalCommandRequest): Promise<HandleCommandResult>;
}

export interface SecurityPorts {
  readonly authentication: AuthenticationPort;
  readonly principals: PrincipalAuthority;
  readonly fundingEvidence: FundingEvidencePort;
  readonly principalRateLimiter: RateLimiter;
}

export function composeRuntime(
  config: PostgresConfig,
  security?: Partial<SecurityPorts>,
  rateLimiting?: RateLimitingConfig,
  telemetry: SecurityTelemetry = noOpSecurityTelemetry,
): ComposedRuntime {
  const persistence = new PostgresPersistenceAdapter(config, telemetry);
  const clock = systemClock();
  const eventIds = createEventIdFactory(createProcessEventIdPrefix());
  const application = new CellApplication({
    persistence,
    kernel: cellKernel,
    clock,
    eventIds,
  });
  const gate = createCommandGate();
  const principalRateLimiter = security?.principalRateLimiter ?? (rateLimiting === undefined
    ? allowAllRateLimiter
    : new PostgresFixedWindowRateLimiter(persistence.rateLimitStore, 'PRINCIPAL', rateLimiting.principal));
  const preAuthenticationRateLimiter = rateLimiting === undefined
    ? allowAllRateLimiter
    : new PostgresFixedWindowRateLimiter(persistence.rateLimitStore, 'PRE_AUTH', rateLimiting.preAuth);
  const ingress = new TrustedCommandIngress(
    application,
    security?.authentication ?? failClosedAuthentication,
    security?.principals ?? persistence.principalAuthority,
    security?.fundingEvidence ?? rejectAllFundingEvidence,
    principalRateLimiter,
    telemetry,
  );

  return {
    persistence,
    gate,
    preAuthenticationRateLimiter,
    telemetry,
    handleCommand(request: ExternalCommandRequest): Promise<HandleCommandResult> {
      return gate.run(() => ingress.handle(request));
    },
  };
}

export async function performShutdown(args: {
  readonly gate: CommandGate;
  readonly disconnect: () => Promise<void>;
  readonly timeoutMs?: number;
  readonly exit: (code: number) => void;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  args.gate.beginShutdown();

  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve('timeout');
    }, timeoutMs);
  });

  try {
    await Promise.race([args.gate.drain(), expire]);

    const disconnecting = args.disconnect();

    if (expired) {
      void disconnecting.catch(() => undefined);
      reportShutdownFailure();
      args.exit(1);
      return;
    }

    try {
      const result = await Promise.race([
        disconnecting.then(() => 'completed' as const),
        expire,
      ]);
      if (result === 'timeout') {
        reportShutdownFailure();
        args.exit(1);
        return;
      }
    } catch {
      reportShutdownFailure();
      args.exit(1);
      return;
    }

    args.exit(0);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function reportConfigurationError(error: ConfigurationError): void {
  process.stderr.write(`${error.message}\n`);
}

function reportStartupFailure(): void {
  process.stderr.write('Persistence startup failed\n');
}

function reportShutdownFailure(): void {
  process.stderr.write('Shutdown failed\n');
}

export async function main(
  env: EnvMap = process.env,
  exit: (code: number) => void = (code) => {
    process.exit(code);
  },
): Promise<void> {
  let config: PostgresConfig;
  let authenticationConfig: JwtAuthenticationConfig;
  let transportConfig: CommandHttpsConfig;
  let rateLimitingConfig: RateLimitingConfig;
  let observabilityConfig: SecurityObservabilityConfig;
  try {
    config = loadPostgresConfig(env);
    authenticationConfig = loadAuthenticationConfig(env);
    transportConfig = loadPublicIngressConfig(env);
    rateLimitingConfig = loadRateLimitingConfig(env);
    observabilityConfig = loadSecurityObservabilityConfig(env);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      reportConfigurationError(error);
      exit(1);
      return;
    }
    reportStartupFailure();
    exit(1);
    return;
  }

  const telemetry = createProductionSecurityTelemetry(observabilityConfig);
  const authentication = new JwtAuthenticationAdapter(
    authenticationConfig,
    new CachedJwksProvider(
      new HttpJwksFetcher(), authenticationConfig.jwksCacheTtlMs,
      authenticationConfig.jwksTimeoutMs,
    ),
  );
  const runtime = composeRuntime(config, { authentication }, rateLimitingConfig, telemetry);
  let transport: CommandHttpsTransport | undefined;

  try {
    transport = await CommandHttpsTransport.create(
      runtime, transportConfig, new JsonLineTransportAuditSink(), undefined,
      runtime.preAuthenticationRateLimiter, runtime.telemetry,
    );
    await runtime.persistence.connect();
    await runtime.persistence.migrator.verifyExpectedVersion();
    await transport.listen();
  } catch {
    try {
      await transport?.close();
      await runtime.persistence.disconnect();
    } catch {
      // Opaque startup failure only. Do not expose disconnect errors.
    }
    reportStartupFailure();
    exit(1);
    return;
  }

  let shuttingDown = false;
  const runShutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void performShutdown({
      gate: runtime.gate,
      disconnect: async () => {
        await transport?.close();
        await runtime.persistence.disconnect();
      },
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
      exit,
    });
  };

  process.on('SIGTERM', runShutdown);
  process.on('SIGINT', runShutdown);

  await parkUntilExit();
}

function parkUntilExit(): Promise<void> {
  return new Promise(() => {
    // Remain alive until signal-driven shutdown calls process.exit.
  });
}

const executedDirectly =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (executedDirectly) {
  void main();
}
