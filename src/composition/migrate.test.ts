/**
 * ZINESH PROTOCOL V2 — One-shot schema apply tests
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Pool } from 'pg';
import { migrateMain } from './migrate';
import { PostgresPersistenceAdapter } from '../adapters/postgres-persistence-adapter';
import { PostgresMigrator, SchemaVersionError, EXPECTED_SCHEMA_VERSION } from '../adapters/postgres-migrator';
import { CommandHttpsTransport } from '../transport/command-https-transport';
import { selfSignedTestCertificate } from '../transport/tls-test-certificate';

const POSTGRES_CONFIG_DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), 'zinesh-migrate-config-'));
const POSTGRES_PASSWORD = 'migrate-secret-must-never-appear';
const POSTGRES_PASSWORD_PATH = path.join(POSTGRES_CONFIG_DIRECTORY, 'password');
const POSTGRES_CA_PATH = path.join(POSTGRES_CONFIG_DIRECTORY, 'ca.pem');
const POSTGRES_CA_CONTENT = selfSignedTestCertificate(
  new Date(Date.now() - 60_000), new Date(Date.now() + 3_600_000), 'db.example.internal',
).certificate;
fs.writeFileSync(POSTGRES_PASSWORD_PATH, `${POSTGRES_PASSWORD}\n`, { mode: 0o600 });
fs.writeFileSync(POSTGRES_CA_PATH, POSTGRES_CA_CONTENT);
afterAll(() => fs.rmSync(POSTGRES_CONFIG_DIRECTORY, { recursive: true, force: true }));

const PG_ENV = {
  PGHOST: 'db.example.internal',
  PGPORT: '5432',
  PGDATABASE: 'zinesh',
  PGUSER: 'zinesh',
  PG_PASSWORD_FILE: POSTGRES_PASSWORD_PATH,
  PG_TLS_MODE: 'verify-full',
  PG_TLS_CA_PATH: POSTGRES_CA_PATH,
};

const POSTGRES_ENABLED = process.env['ZINESH_POSTGRES_TESTS'] === 'true';

function migrateSource(): string {
  return fs.readFileSync(path.join(__dirname, 'migrate.ts'), 'utf8');
}

describe('one-shot schema apply command', () => {
  test('missing postgres configuration exits 1 without HTTPS or secrets', async () => {
    const httpsCreate = jest.spyOn(CommandHttpsTransport, 'create');
    const codes: number[] = [];
    try {
      await migrateMain({}, (code) => { codes.push(code); });
      expect(codes).toEqual([1]);
      expect(httpsCreate).not.toHaveBeenCalled();
    } finally {
      httpsCreate.mockRestore();
    }
  });

  test('rejects PGPASSWORD and does not print the secret', async () => {
    const codes: number[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await migrateMain({ ...PG_ENV, PGPASSWORD: POSTGRES_PASSWORD }, (code) => { codes.push(code); });
      expect(codes).toEqual([1]);
      const output = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toMatch(/PGPASSWORD/);
      expect(output).not.toContain(POSTGRES_PASSWORD);
    } finally {
      stderr.mockRestore();
    }
  });

  test('group-accessible password file fails closed without leaking the secret', async () => {
    fs.chmodSync(POSTGRES_PASSWORD_PATH, 0o640);
    const codes: number[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await migrateMain(PG_ENV, (code) => { codes.push(code); });
      expect(codes).toEqual([1]);
      const output = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toMatch(/^Invalid configuration: PG_PASSWORD_FILE /);
      expect(output).not.toContain(POSTGRES_PASSWORD);
    } finally {
      fs.chmodSync(POSTGRES_PASSWORD_PATH, 0o600);
      stderr.mockRestore();
    }
  });

  test('applies schema, verifies expected version, and never starts HTTPS', async () => {
    const httpsCreate = jest.spyOn(CommandHttpsTransport, 'create');
    const connect = jest.spyOn(PostgresPersistenceAdapter.prototype, 'connect').mockResolvedValue();
    const disconnect = jest.spyOn(PostgresPersistenceAdapter.prototype, 'disconnect').mockResolvedValue();
    const migrate = jest.spyOn(PostgresMigrator.prototype, 'migrate').mockResolvedValue();
    const verify = jest.spyOn(PostgresMigrator.prototype, 'verifyExpectedVersion').mockResolvedValue();
    const codes: number[] = [];
    try {
      await migrateMain(PG_ENV, (code) => { codes.push(code); });
      expect(codes).toEqual([0]);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(migrate).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(httpsCreate).not.toHaveBeenCalled();
      expect(connect.mock.invocationCallOrder[0]).toBeLessThan(migrate.mock.invocationCallOrder[0]!);
      expect(migrate.mock.invocationCallOrder[0]).toBeLessThan(verify.mock.invocationCallOrder[0]!);
    } finally {
      httpsCreate.mockRestore();
      connect.mockRestore();
      disconnect.mockRestore();
      migrate.mockRestore();
      verify.mockRestore();
    }
  });

  test('schema apply failures are opaque and still disconnect', async () => {
    const connect = jest.spyOn(PostgresPersistenceAdapter.prototype, 'connect').mockResolvedValue();
    const disconnect = jest.spyOn(PostgresPersistenceAdapter.prototype, 'disconnect').mockResolvedValue();
    const migrate = jest.spyOn(PostgresMigrator.prototype, 'migrate')
      .mockRejectedValue(new Error(`SQL password=${POSTGRES_PASSWORD} host=db.example.internal`));
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const codes: number[] = [];
    try {
      await migrateMain(PG_ENV, (code) => { codes.push(code); });
      expect(codes).toEqual([1]);
      expect(disconnect).toHaveBeenCalledTimes(1);
      const output = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toBe('Persistence startup failed\n');
      expect(output).not.toContain(POSTGRES_PASSWORD);
      expect(output).not.toContain('db.example.internal');
      expect(output).not.toContain('SQL');
    } finally {
      connect.mockRestore();
      disconnect.mockRestore();
      migrate.mockRestore();
      stderr.mockRestore();
    }
  });

  test('verify failure after apply is fail-closed and opaque', async () => {
    const connect = jest.spyOn(PostgresPersistenceAdapter.prototype, 'connect').mockResolvedValue();
    const disconnect = jest.spyOn(PostgresPersistenceAdapter.prototype, 'disconnect').mockResolvedValue();
    const migrate = jest.spyOn(PostgresMigrator.prototype, 'migrate').mockResolvedValue();
    const verify = jest.spyOn(PostgresMigrator.prototype, 'verifyExpectedVersion')
      .mockRejectedValue(new SchemaVersionError('Expected schema version 4'));
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const codes: number[] = [];
    try {
      await migrateMain(PG_ENV, (code) => { codes.push(code); });
      expect(codes).toEqual([1]);
      const output = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toBe('Persistence startup failed\n');
      expect(output).not.toContain('4');
    } finally {
      connect.mockRestore();
      disconnect.mockRestore();
      migrate.mockRestore();
      verify.mockRestore();
      stderr.mockRestore();
    }
  });

  test('source is not a serving process', () => {
    const src = migrateSource();
    expect(src).toMatch(/migrator\.migrate\(/);
    expect(src).toMatch(/verifyExpectedVersion/);
    expect(src).toMatch(/loadPostgresConfig/);
    expect(src).not.toMatch(/CommandHttpsTransport/);
    expect(src).not.toMatch(/JwtAuthenticationAdapter/);
    expect(src).not.toMatch(/listen\(/);
    expect(src).not.toMatch(/\/live/);
    expect(src).not.toMatch(/\/ready/);
    expect(src).not.toMatch(/loadPublicIngressConfig/);
    expect(src).not.toMatch(/loadAuthenticationConfig/);
  });
});

const maybeDescribe = POSTGRES_ENABLED ? describe : describe.skip;

maybeDescribe('one-shot schema apply against PostgreSQL', () => {
  let admin: Pool;
  const names: string[] = [];

  beforeAll(() => {
    admin = new Pool({
      host: process.env['PGHOST'], port: Number(process.env['PGPORT']),
      database: process.env['PGDATABASE'], user: process.env['PGUSER'],
      password: fs.readFileSync(process.env['PG_PASSWORD_FILE']!, 'utf8'),
      ssl: { ca: fs.readFileSync(process.env['PG_TLS_CA_PATH']!, 'utf8'), rejectUnauthorized: true },
    });
  });

  afterAll(async () => {
    for (const name of names) {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [name],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    }
    await admin.end();
  });

  async function database(prefix: string): Promise<string> {
    const name = `${prefix}_${process.pid}_${names.length}`.replace(/[^a-z0-9_]/g, '');
    names.push(name);
    await admin.query(`CREATE DATABASE ${name}`);
    return name;
  }

  function envFor(databaseName: string): NodeJS.ProcessEnv {
    return {
      PGHOST: process.env['PGHOST'],
      PGPORT: process.env['PGPORT'],
      PGDATABASE: databaseName,
      PGUSER: process.env['PGUSER'],
      PG_PASSWORD_FILE: process.env['PG_PASSWORD_FILE'],
      PG_TLS_MODE: 'verify-full',
      PG_TLS_CA_PATH: process.env['PG_TLS_CA_PATH'],
    };
  }

  test('fresh database reaches expected versions and a second apply is a no-op', async () => {
    const name = await database('zinesh_apply');
    const codes: number[] = [];
    await migrateMain(envFor(name), (code) => { codes.push(code); });
    await migrateMain(envFor(name), (code) => { codes.push(code); });
    expect(codes).toEqual([0, 0]);
    const pool = new Pool({
      host: process.env['PGHOST'], port: Number(process.env['PGPORT']),
      database: name, user: process.env['PGUSER'],
      password: fs.readFileSync(process.env['PG_PASSWORD_FILE']!, 'utf8'),
      ssl: { ca: fs.readFileSync(process.env['PG_TLS_CA_PATH']!, 'utf8'), rejectUnauthorized: true },
    });
    try {
      expect((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows)
        .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }]);
      expect(EXPECTED_SCHEMA_VERSION).toBe(6);
      expect((await pool.query('SELECT name FROM schema_migrations WHERE version=6')).rows)
        .toEqual([{ name: 'funding-intents-held-semantics-disputes' }]);
    } finally {
      await pool.end();
    }
  });

  test('wrong PostgreSQL CA fails closed without leaking secrets', async () => {
    const name = await database('zinesh_wrong_ca');
    const codes: number[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const password = fs.readFileSync(process.env['PG_PASSWORD_FILE']!, 'utf8');
    try {
      await migrateMain({
        ...envFor(name),
        PG_TLS_CA_PATH: process.env['PG_TLS_WRONG_CA_PATH'],
      }, (code) => { codes.push(code); });
      expect(codes).toEqual([1]);
      const output = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toBe('Persistence startup failed\n');
      expect(output).not.toContain(password);
    } finally {
      stderr.mockRestore();
    }
  });
});
