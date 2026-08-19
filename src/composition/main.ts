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
import type { HandleCommandRequest, HandleCommandResult } from '../application/types';
import { cellKernel } from '../kernel';

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
  readonly application: CellApplication;
  readonly gate: CommandGate;
  handleCommand(request: HandleCommandRequest): Promise<HandleCommandResult>;
}

export function composeRuntime(config: PostgresConfig): ComposedRuntime {
  const persistence = new PostgresPersistenceAdapter(config);
  const clock = systemClock();
  const eventIds = createEventIdFactory(createProcessEventIdPrefix());
  const application = new CellApplication({
    persistence,
    kernel: cellKernel,
    clock,
    eventIds,
  });
  const gate = createCommandGate();

  return {
    persistence,
    application,
    gate,
    handleCommand(request: HandleCommandRequest): Promise<HandleCommandResult> {
      return gate.run(() => application.handleCommand(request));
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
  try {
    config = loadPostgresConfig(env);
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

  const runtime = composeRuntime(config);

  try {
    await runtime.persistence.connect();
  } catch {
    try {
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
      disconnect: () => runtime.persistence.disconnect(),
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
