/**
 * ZINESH PROTOCOL V2 — Composition Root tests
 *
 * No PostgreSQL server. No Kernel mocks. No Application/Kernel test changes.
 */

import fs from 'fs';
import path from 'path';
import {
  ConfigurationError,
  RuntimeUnavailableError,
  SHUTDOWN_TIMEOUT_MS,
  composeRuntime,
  createCommandGate,
  createProcessEventIdPrefix,
  loadPostgresConfig,
  main,
  performShutdown,
} from './main';
import { CellApplication } from '../application/cell-application';
import { PostgresPersistenceAdapter } from '../adapters/postgres-persistence-adapter';
import { InMemoryPersistenceAdapter } from '../adapters/in-memory-persistence-adapter';
import { createEventIdFactory } from '../application/event-id-factory';
import { fixedClock } from '../application/clock';
import { cellKernel } from '../kernel';
import {
  makeActorId,
  makeAmount,
  makeCellId,
  makeCommandId,
  makeTimestamp,
} from '../core/types';
import type { HandleCommandRequest } from '../application/types';

const VALID_ENV = {
  PGHOST: 'db.example.internal',
  PGPORT: '5432',
  PGDATABASE: 'zinesh',
  PGUSER: 'zinesh',
  PGPASSWORD: 'secret-must-never-appear',
};

function compositionSource(): string {
  return fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
}

describe('loadPostgresConfig', () => {
  test('reads the five required libpq variables', () => {
    const config = loadPostgresConfig(VALID_ENV);
    expect(config).toEqual({
      host: 'db.example.internal',
      port: 5432,
      database: 'zinesh',
      user: 'zinesh',
      password: 'secret-must-never-appear',
    });
  });

  test.each(['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'] as const)(
    'fails fast when %s is missing',
    (name) => {
      const env = { ...VALID_ENV };
      delete env[name];
      expect(() => loadPostgresConfig(env)).toThrow(ConfigurationError);
      try {
        loadPostgresConfig(env);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        if (!(error instanceof ConfigurationError)) return;
        expect(error.variable).toBe(name);
        expect(error.message).toContain(name);
        expect(error.message).not.toContain('secret-must-never-appear');
      }
    },
  );

  test.each(['PGHOST', 'PGDATABASE', 'PGUSER'] as const)(
    'rejects empty %s',
    (name) => {
      expect(() => loadPostgresConfig({ ...VALID_ENV, [name]: '' })).toThrow(
        ConfigurationError,
      );
    },
  );

  test('rejects empty PGPASSWORD', () => {
    expect(() => loadPostgresConfig({ ...VALID_ENV, PGPASSWORD: '' })).toThrow(
      ConfigurationError,
    );
  });

  test('rejects whitespace-only PGPASSWORD without echoing it', () => {
    try {
      loadPostgresConfig({ ...VALID_ENV, PGPASSWORD: '   ' });
      throw new Error('expected ConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      if (!(error instanceof ConfigurationError)) return;
      expect(error.variable).toBe('PGPASSWORD');
      expect(error.message).not.toContain('   ');
      expect(error.message).not.toContain('secret');
    }
  });

  test('rejects PGPORT trailing junk such as 5432abc', () => {
    try {
      loadPostgresConfig({ ...VALID_ENV, PGPORT: '5432abc' });
      throw new Error('expected ConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      if (!(error instanceof ConfigurationError)) return;
      expect(error.variable).toBe('PGPORT');
      expect(error.message).toContain('PGPORT');
      expect(error.message).not.toContain('5432abc');
      expect(error.message).not.toContain(VALID_ENV.PGPASSWORD);
    }
  });

  test('rejects PGPORT 0 and 65536', () => {
    expect(() => loadPostgresConfig({ ...VALID_ENV, PGPORT: '0' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadPostgresConfig({ ...VALID_ENV, PGPORT: '65536' })).toThrow(
      ConfigurationError,
    );
  });

  test('accepts PGPORT 1 and 65535', () => {
    expect(loadPostgresConfig({ ...VALID_ENV, PGPORT: '1' }).port).toBe(1);
    expect(loadPostgresConfig({ ...VALID_ENV, PGPORT: '65535' }).port).toBe(65535);
  });

  test('does not apply production defaults', () => {
    expect(() => loadPostgresConfig({})).toThrow(ConfigurationError);
  });
});

describe('createProcessEventIdPrefix', () => {
  test('uses evt-${timestamp} without randomness', () => {
    expect(createProcessEventIdPrefix(1_700_000_000_000)).toBe('evt-1700000000000');
  });
});

describe('createCommandGate', () => {
  test('rejects new work after shutdown and drains in-flight work', async () => {
    const gate = createCommandGate();
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = gate.run(async () => {
      await blocked;
      return 'done';
    });

    expect(gate.inFlight).toBe(1);
    gate.beginShutdown();
    await expect(gate.run(async () => 'nope')).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );

    const drained = gate.drain();
    let drainedResolved = false;
    void drained.then(() => {
      drainedResolved = true;
    });
    await Promise.resolve();
    expect(drainedResolved).toBe(false);

    release();
    await expect(inFlight).resolves.toBe('done');
    await drained;
    expect(gate.inFlight).toBe(0);
    expect(drainedResolved).toBe(true);
  });

  test('drain resolves immediately when idle', async () => {
    const gate = createCommandGate();
    gate.beginShutdown();
    await gate.drain();
    expect(gate.inFlight).toBe(0);
  });
});

describe('performShutdown', () => {
  test('exits 0 after drain and disconnect', async () => {
    const gate = createCommandGate();
    const codes: number[] = [];
    let disconnected = false;
    await performShutdown({
      gate,
      disconnect: async () => {
        disconnected = true;
      },
      timeoutMs: 100,
      exit: (code) => {
        codes.push(code);
      },
    });
    expect(disconnected).toBe(true);
    expect(codes).toEqual([0]);
  });

  test('exits 1 when disconnect hangs past the timeout', async () => {
    const gate = createCommandGate();
    const codes: number[] = [];
    await performShutdown({
      gate,
      disconnect: () => new Promise(() => undefined),
      timeoutMs: 30,
      exit: (code) => {
        codes.push(code);
      },
    });
    expect(codes).toEqual([1]);
  });

  test('exits 1 when disconnect throws', async () => {
    const gate = createCommandGate();
    const codes: number[] = [];
    await performShutdown({
      gate,
      disconnect: async () => {
        throw new Error('password=super-secret host=db');
      },
      timeoutMs: 100,
      exit: (code) => {
        codes.push(code);
      },
    });
    expect(codes).toEqual([1]);
  });

  test('shutdown timeout constant is 10 seconds', () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });
});

describe('main configuration path', () => {
  test('missing env exits 1 without parking', async () => {
    const codes: number[] = [];
    await main({}, (code) => {
      codes.push(code);
    });
    expect(codes).toEqual([1]);
  });
});

describe('composeRuntime wiring', () => {
  test('constructs PostgresPersistenceAdapter and CellApplication without connect', async () => {
    const runtime = composeRuntime({
      host: '127.0.0.1',
      port: 1,
      database: 'unused',
      user: 'unused',
      password: 'unused',
    });
    try {
      expect(runtime.persistence).toBeInstanceOf(PostgresPersistenceAdapter);
      expect(runtime.application).toBeInstanceOf(CellApplication);
    } finally {
      await runtime.persistence.disconnect();
    }
  });
});

describe('in-flight gate with real CellApplication', () => {
  test('does not inspect commands and still forwards before shutdown', async () => {
    const persistence = new InMemoryPersistenceAdapter();
    const application = new CellApplication({
      persistence,
      kernel: cellKernel,
      clock: fixedClock(makeTimestamp(1_000_000)),
      eventIds: createEventIdFactory('comp-test'),
    });
    const gate = createCommandGate();

    const request: HandleCommandRequest = {
      command: {
        commandId: makeCommandId('cmd-comp-1'),
        cellId: makeCellId('cell-comp-1'),
        type: 'CreateCell',
        payload: {
          payer: makeActorId('payer-1'),
          payee: makeActorId('payee-1'),
          amount: makeAmount(10000n),
          currency: 'TRY',
          fundingDeadline: makeTimestamp(2_000_000),
          completionDeadline: makeTimestamp(5_000_000),
        },
      },
      caller: { authenticated: true, actorId: makeActorId('payer-1') },
    };

    const result = await gate.run(() => application.handleCommand(request));
    expect(result.outcome).toBe('SUCCESS');

    gate.beginShutdown();
    await expect(gate.run(() => application.handleCommand(request))).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );
  });
});

describe('constitution', () => {
  test('composition root contains no SQL, HTTP, domain engine, or extra env', () => {
    const src = compositionSource();
    expect(src).not.toMatch(/\bSELECT\b/);
    expect(src).not.toMatch(/\bINSERT\b/);
    expect(src).not.toMatch(/\bUPDATE\b/);
    expect(src).not.toMatch(/\bDELETE\b/);
    expect(src).not.toMatch(/\bJOIN\b/);
    expect(src).not.toMatch(/CREATE TABLE/);
    expect(src).not.toMatch(/postgres-schema/);
    expect(src).not.toMatch(/InMemoryPersistenceAdapter/);
    expect(src).not.toMatch(/PostgresEventStore/);
    expect(src).not.toMatch(/PostgresSnapshotStore/);
    expect(src).not.toMatch(/from ['"]pg['"]/);
    expect(src).not.toMatch(/express/i);
    expect(src).not.toMatch(/fastify/i);
    expect(src).not.toMatch(/createServer/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/randomUUID/);
    expect(src).not.toMatch(/ZINESH_POSTGRES_TESTS/);
    expect(src).not.toMatch(/NODE_ENV/);
    expect(src).not.toMatch(/LOG_LEVEL/);
    expect(src).not.toMatch(/APP_NAME/);
    expect(src).not.toMatch(/TERMINAL_STATUSES/);
    expect(src).not.toMatch(/eventFolder/);
    expect(src).not.toMatch(/DEADLINE_VIOLATION/);
    expect(src).toMatch(/PostgresPersistenceAdapter/);
    expect(src).toMatch(/cellKernel/);
    expect(src).toMatch(/systemClock/);
    expect(src).toMatch(/createEventIdFactory/);
    expect(src).toMatch(/SIGTERM/);
    expect(src).toMatch(/SIGINT/);
    expect(src).toMatch(/evt-\$\{/);
  });
});
