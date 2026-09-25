import { setTimeout as delay } from 'timers/promises';
import { PostgresPersistenceAdapter } from '../adapters/postgres-persistence-adapter';
import type { PostgresConfig } from '../adapters/postgres-persistence-adapter';
import {
  ConfigurationError,
  loadPostgresConfig,
  loadPrototypeFundingConfig,
  loadTransportConfig,
  performShutdown,
} from '../composition/main';
import type { EnvMap } from '../composition/main';
import { CachedJwksProvider, JwtAuthenticationAdapter } from '../security/jwt-authentication';
import { CommandHttpTransport } from '../transport/command-http-transport';
import { JsonLineTransportAuditSink } from '../transport/command-http-transport';
import type { CommandHttpConfig, ProcessProbes } from '../transport/command-http-transport';
import { composeDevelopmentRuntime } from './prototype-runtime';
import { DevelopmentIdentityIssuer } from './development-identity-issuer';
import {
  assertDevelopmentProvisioningEnvironment,
  provisionDevelopmentActors,
} from './provision-development-actors';
import { createDevelopmentHttpServerFactory, DEVELOPMENT_BROWSER_ORIGIN } from './development-http';

export const DEVELOPMENT_HTTP_DEFAULT_PORT = 8787;
const POSTGRES_READY_ATTEMPTS = 20;
const POSTGRES_READY_RETRY_MS = 500;
const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface DevelopmentHttpConfig extends CommandHttpConfig {
  readonly browserOrigin: string;
}

export interface DevelopmentLauncherConfig {
  readonly postgres: PostgresConfig;
  readonly http: DevelopmentHttpConfig;
}

/** Validate the development-only switches before reading credentials or opening PostgreSQL. */
export function assertDevelopmentLauncherEnvironment(env: EnvMap): void {
  assertDevelopmentProvisioningEnvironment(env);
  const prototypeFunding = loadPrototypeFundingConfig(env);
  if (prototypeFunding.environment !== 'development' || !prototypeFunding.enabled) {
    throw new ConfigurationError('PROTOTYPE_FUNDING_ENABLED', 'must be true for the development launcher');
  }
}

export function loadDevelopmentLauncherConfig(env: EnvMap): DevelopmentLauncherConfig {
  assertDevelopmentLauncherEnvironment(env);
  const postgres = loadPostgresConfig(env);
  const http = loadDevelopmentHttpConfig(env);
  return { postgres, http };
}

export function loadDevelopmentHttpConfig(env: EnvMap): DevelopmentHttpConfig {
  assertDevelopmentLauncherEnvironment(env);
  const normalized: EnvMap = {
    ...env,
    HTTP_HOST: env['HTTP_HOST'] ?? '127.0.0.1',
    HTTP_PORT: env['HTTP_PORT'] ?? String(DEVELOPMENT_HTTP_DEFAULT_PORT),
    HTTP_MAX_BODY_BYTES: env['HTTP_MAX_BODY_BYTES'] ?? '65536',
    HTTP_MAX_HEADER_BYTES: env['HTTP_MAX_HEADER_BYTES'] ?? '16384',
    HTTP_REQUEST_TIMEOUT_MS: env['HTTP_REQUEST_TIMEOUT_MS'] ?? '15000',
    HTTP_HEADERS_TIMEOUT_MS: env['HTTP_HEADERS_TIMEOUT_MS'] ?? '5000',
    HTTP_MAX_CONCURRENT_REQUESTS: env['HTTP_MAX_CONCURRENT_REQUESTS'] ?? '100',
  };
  const transport = loadTransportConfig(normalized);
  const browserOrigin = env['ZINESH_DEVELOPMENT_WEB_ORIGIN'] ?? DEVELOPMENT_BROWSER_ORIGIN;
  if (!isLoopbackHttpOrigin(browserOrigin)) {
    throw new ConfigurationError('ZINESH_DEVELOPMENT_WEB_ORIGIN', 'must be an exact loopback HTTP origin');
  }
  return { ...transport, browserOrigin };
}

/** Start the database-backed development runtime. PostgreSQL must already be reachable. */
export async function startDevelopmentRuntime(
  env: EnvMap = process.env,
): Promise<{
  readonly address: { readonly address: string; readonly port: number };
  readonly gate: ReturnType<typeof composeDevelopmentRuntime>['gate'];
  readonly close: () => Promise<void>;
}> {
  const config = loadDevelopmentLauncherConfig(env);
  const bootstrapPersistence = new PostgresPersistenceAdapter(config.postgres);
  try {
    await waitForPostgres(() => bootstrapPersistence.connect());
    await bootstrapPersistence.migrator.migrate();
    await bootstrapPersistence.migrator.verifyExpectedVersion();
    const provisioned = await provisionDevelopmentActors(bootstrapPersistence.principalAuthority);
    for (const actor of provisioned) {
      process.stdout.write(`${actor.identity}: ${actor.outcome} (${actor.actorId})\n`);
    }
  } finally {
    await bootstrapPersistence.disconnect();
  }

  const issuer = new DevelopmentIdentityIssuer();
  const authenticationConfig = issuer.authenticationConfig();
  const authentication = new JwtAuthenticationAdapter(
    authenticationConfig,
    new CachedJwksProvider(issuer, authenticationConfig.jwksCacheTtlMs, authenticationConfig.jwksTimeoutMs),
  );
  const runtime = composeDevelopmentRuntime(config.postgres, { authentication });
  let transport: CommandHttpTransport | undefined;
  try {
    await waitForPostgres(() => runtime.persistence.connect());
    await runtime.persistence.migrator.verifyExpectedVersion();
    let shuttingDown = false;
    const probes: ProcessProbes = {
      shuttingDown: () => shuttingDown,
      readyCheck: () => runtime.persistence.readyCheck(),
    };
    transport = new CommandHttpTransport(
      runtime,
      config.http,
      new JsonLineTransportAuditSink(),
      undefined,
      createDevelopmentHttpServerFactory(issuer, config.http.browserOrigin, config.http.maxHeaderBytes),
      undefined,
      runtime.preAuthenticationRateLimiter,
      runtime.telemetry,
      probes,
    );
    await transport.listen();
    const address = transport.address();
    if (address === null) throw new Error('Development HTTP listener has no address');

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closing !== undefined) return closing;
      shuttingDown = true;
      runtime.gate.beginShutdown();
      closing = runtime.gate.drain().then(async () => {
        await transport!.close();
        await runtime.persistence.disconnect();
      });
      return closing;
    };
    return { address, gate: runtime.gate, close };
  } catch (error) {
    try {
      await transport?.close();
      await runtime.persistence.disconnect();
    } catch {
      // Preserve the startup failure without exposing connection details.
    }
    throw error;
  }
}

async function waitForPostgres(connect: () => Promise<void>): Promise<void> {
  for (let attempt = 1; attempt <= POSTGRES_READY_ATTEMPTS; attempt += 1) {
    try { await connect(); return; }
    catch (error) {
      if (attempt === POSTGRES_READY_ATTEMPTS) throw error;
      await delay(POSTGRES_READY_RETRY_MS);
    }
  }
}

function isLoopbackHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.origin === value && url.username === '' && url.password === ''
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch { return false; }
}

async function main(): Promise<void> {
  const server = await startDevelopmentRuntime();
  const host = server.address.address.includes(':') ? `[${server.address.address}]` : server.address.address;
  process.stdout.write(`Development backend listening at http://${host}:${server.address.port}\n`);
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void performShutdown({
      gate: server.gate,
      disconnect: server.close,
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
      exit: (code) => process.exit(code),
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  void main().catch(() => {
    process.stderr.write('Development launcher failed; verify the local PostgreSQL and development configuration\n');
    process.exitCode = 1;
  });
}
