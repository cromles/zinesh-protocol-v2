'use strict';

const assert = require('node:assert/strict');
const { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { request } = require('node:https');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');
const { Pool } = require('pg');

const image = process.argv[2];
assert.ok(image, 'usage: node scripts/verify-backup-restore.cjs <image>');
for (const name of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PG_PASSWORD_FILE', 'PG_TLS_CA_PATH',
  'PG_TLS_DOCKER_NETWORK', 'PG_TLS_DOCKER_HOST']) {
  assert.ok(process.env[name], `${name} is required for backup/restore smoke`);
}
assert.equal(process.env.PGPASSWORD, undefined, 'PGPASSWORD is not accepted for backup/restore');
assert.equal(process.env.PG_TLS_MODE ?? 'verify-full', 'verify-full');

const distMain = join(__dirname, '..', 'dist', 'composition', 'main.js');
const distKernel = join(__dirname, '..', 'dist', 'kernel', 'index.js');
assert.equal(require('node:fs').existsSync(distMain), true, 'compiled composition root is missing');
assert.equal(require('node:fs').existsSync(distKernel), true, 'compiled kernel is missing');

const { composeRuntime, loadPostgresConfig } = require(distMain);
const { cellKernel } = require(distKernel);

const suffix = `${process.pid}-${Date.now()}`;
const sourceDatabase = `zinesh_backup_src_${process.pid}_${Date.now()}`;
const restoredDatabase = `zinesh_backup_dst_${process.pid}_${Date.now()}`;
const emptyDatabase = `zinesh_backup_empty_${process.pid}_${Date.now()}`;
const servingContainer = `zinesh-backup-ready-${suffix}`;
const emptyContainer = `zinesh-backup-empty-${suffix}`;
const volume = `zinesh-backup-tls-${suffix}`;
const directory = mkdtempSync(join(tmpdir(), 'zinesh-backup-restore-'));
const dumpPath = join(directory, 'zinesh.dump');
const pgpassPath = join(directory, 'pgpass');
const caPath = join(directory, 'database-ca.pem');
const base = 'node:24.18.1-alpine3.23@sha256:ba63d8e0b5d4cbc6db9da12ea77ddb35a4783ad653a092ef115cc383526d4369';
const postgresClient = 'postgres:16-alpine';
const password = readFileSync(process.env.PG_PASSWORD_FILE, 'utf8').replace(/\n$/, '').replace(/\r$/, '');
const CELL_ID = 'backup-cell-1';
const COMMAND_ID = 'backup-create-1';
const PRINCIPAL_ID = 'backup-principal-1';
const ISSUER = 'https://backup.restore.test';
const SUBJECT = 'backup-subject-1';
let createdSource = false;
let createdRestored = false;
let createdEmpty = false;
let preBackup;

void execute().catch(async (error) => {
  await cleanup();
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

async function execute() {
  const admin = new Pool(postgresConfig(process.env.PGDATABASE));
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(sourceDatabase)}`);
    createdSource = true;
    await admin.query(`CREATE DATABASE ${quoteIdentifier(restoredDatabase)}`);
    createdRestored = true;
    await admin.query(`CREATE DATABASE ${quoteIdentifier(emptyDatabase)}`);
    createdEmpty = true;
  } finally {
    await admin.end();
  }

  const fixture = loadTlsFixture();
  const now = new Date();
  const tls = fixture.selfSignedTestCertificate(
    new Date(now.getTime() - 60_000), new Date(now.getTime() + 3_600_000), 'localhost',
  );
  writeFileSync(join(directory, 'certificate.pem'), tls.certificate, { mode: 0o600 });
  writeFileSync(join(directory, 'private-key.pem'), tls.privateKey, { mode: 0o600 });
  writeFileSync(join(directory, 'database-password'), password, { mode: 0o600 });
  writeFileSync(caPath, readFileSync(process.env.PG_TLS_CA_PATH), { mode: 0o600 });
  writeFileSync(pgpassPath, pgpassLine(), { mode: 0o600 });

  run(['volume', 'create', volume]);
  run([
    'run', '--rm',
    '--mount', `type=bind,source=${directory},target=/source,readonly`,
    '--mount', `type=volume,source=${volume},target=/tls`,
    '--entrypoint', 'sh', base, '-c',
    'cp /source/certificate.pem /tls/certificate.pem && cp /source/private-key.pem /tls/private-key.pem && cp /source/database-password /tls/database-password && cp /source/database-ca.pem /tls/database-ca.pem && chown 1000:1000 /tls/* && chmod 600 /tls/database-password /tls/private-key.pem && chmod 644 /tls/database-ca.pem /tls/certificate.pem',
  ]);

  const migrated = runImageMigrate(sourceDatabase);
  assert.equal(migrated.status, 0, `in-image schema apply failed: ${migrated.stderr}`);
  assert.equal(migrated.stdout, '');
  assert.equal(migrated.stderr, '');

  preBackup = await seedAndCapture(sourceDatabase);

  dumpDatabase(sourceDatabase);
  const dumpStat = require('node:fs').statSync(dumpPath);
  assert.ok(dumpStat.size > 0, 'backup file is empty');
  assert.equal(dumpStat.mode & 0o777, 0o600, 'backup file must be 0600');
  const dumpBytes = readFileSync(dumpPath);
  assert.equal(dumpBytes.includes(Buffer.from(password)), false, 'password leaked into dump file');

  restoreDatabase(restoredDatabase);
  await verifyRestoredDatabase(restoredDatabase, preBackup);
  await verifyServingReady(restoredDatabase);
  await verifyEmptyFailClosed(emptyDatabase);

  process.stdout.write('BACKUP PASS\n');
  process.stdout.write('RESTORE PASS\n');
  process.stdout.write('RESTORED READY PASS\n');
  process.stdout.write('EVENT RECONSTRUCTION PASS\n');
  process.stdout.write('IDEMPOTENT REPLAY PASS\n');
  process.stdout.write('PRINCIPAL RESTORE PASS\n');
  process.stdout.write('EMPTY DB FAIL-CLOSED PASS\n');
  process.stdout.write('Backup and restore verification PASS\n');
  await cleanup();
}

async function seedAndCapture(databaseName) {
  const runtime = runtimeFor(databaseName);
  try {
    const created = await runtime.persistence.principalAuthority.create({
      principalId: PRINCIPAL_ID,
      type: 'ACTOR',
      actorId: 'backup-payer-1',
      identity: { issuer: ISSUER, subject: SUBJECT },
      capabilities: ['ACT_AS_SELF'],
      context: { occurredAt: 1_000_000, correlationId: 'backup-create-principal' },
    });
    assert.equal(created.ok, true, `principal create failed: ${encode(created)}`);

    const command = createCellCommand();
    const first = await runtime.handleCommand({ credential: 'backup-credential', command });
    assert.equal(first.outcome, 'SUCCESS', `CreateCell failed: ${encode(first)}`);
    const replay = await runtime.handleCommand({ credential: 'backup-credential', command });
    assert.equal(replay.outcome, 'SUCCESS', `idempotent replay failed: ${encode(replay)}`);

    const events = await runtime.persistence.eventStore.getEvents(CELL_ID);
    assert.equal(events.length, 1, 'replay must not append a second event');
    const evolved = cellKernel.evolve(CELL_ID, events);
    assert.equal(evolved.status, 'CREATED');
    assert.equal(String(evolved.amount), '10000');

    const pool = new Pool(postgresConfig(databaseName));
    try {
      return {
        evolved: encode(evolved),
        events: encode(events),
        schema: (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows,
        commands: (await pool.query(
          'SELECT command_id, fingerprint FROM command_executions WHERE command_id=$1', [COMMAND_ID],
        )).rows,
        principals: (await pool.query(
          'SELECT principal_id, principal_type FROM principals WHERE principal_id=$1', [PRINCIPAL_ID],
        )).rows,
        audit: (await pool.query(
          'SELECT count(*)::int AS count FROM principal_audit WHERE principal_id=$1', [PRINCIPAL_ID],
        )).rows[0].count,
        snapshot: (await pool.query(
          'SELECT version FROM snapshots WHERE cell_id=$1', [CELL_ID],
        )).rows[0] ?? null,
        maxEventVersion: Number((await pool.query(
          'SELECT max(version) AS version FROM events WHERE cell_id=$1', [CELL_ID],
        )).rows[0].version),
      };
    } finally {
      await pool.end();
    }
  } finally {
    await runtime.persistence.disconnect();
  }
}

async function verifyRestoredDatabase(databaseName, expected) {
  const pool = new Pool(postgresConfig(databaseName));
  try {
    assert.deepEqual(
      (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows,
      [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }],
    );
    assert.deepEqual(
      (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows,
      expected.schema,
    );
    const events = (await pool.query(
      'SELECT event_id, cell_id, version FROM events WHERE cell_id=$1 ORDER BY version', [CELL_ID],
    )).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].cell_id, CELL_ID);
    const commands = (await pool.query(
      'SELECT command_id, fingerprint FROM command_executions WHERE command_id=$1', [COMMAND_ID],
    )).rows;
    assert.equal(commands.length, 1);
    assert.deepEqual(commands, expected.commands);
    assert.deepEqual(
      (await pool.query(
        'SELECT principal_id, principal_type FROM principals WHERE principal_id=$1', [PRINCIPAL_ID],
      )).rows,
      expected.principals,
    );
    assert.equal(
      (await pool.query(
        'SELECT count(*)::int AS count FROM principal_audit WHERE principal_id=$1', [PRINCIPAL_ID],
      )).rows[0].count,
      expected.audit,
    );
    assert.ok(expected.audit >= 1);
    const snapshot = (await pool.query(
      'SELECT version FROM snapshots WHERE cell_id=$1', [CELL_ID],
    )).rows[0];
    if (snapshot !== undefined) {
      assert.ok(Number(snapshot.version) <= expected.maxEventVersion,
        'snapshot.version must not exceed max(event.version)');
    }
  } finally {
    await pool.end();
  }

  const runtime = runtimeFor(databaseName);
  try {
    const events = await runtime.persistence.eventStore.getEvents(CELL_ID);
    assert.equal(encode(events), expected.events);
    const evolved = cellKernel.evolve(CELL_ID, events);
    assert.equal(encode(evolved), expected.evolved);
    const replay = await runtime.handleCommand({ credential: 'backup-credential', command: createCellCommand() });
    assert.equal(replay.outcome, 'SUCCESS', `restored replay failed: ${encode(replay)}`);
    const after = await runtime.persistence.eventStore.getEvents(CELL_ID);
    assert.equal(after.length, 1, 'restored replay must not append events');
    assert.equal(encode(after), expected.events);
  } finally {
    await runtime.persistence.disconnect();
  }
}

async function verifyServingReady(databaseName) {
  const environment = servingEnvironment(databaseName);
  const args = [
    'run', '--detach', '--name', servingContainer, '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--network', process.env.PG_TLS_DOCKER_NETWORK,
    '--publish', '127.0.0.1::8443',
    '--mount', `type=volume,source=${volume},target=/run/zinesh-tls,readonly`,
  ];
  for (const [name, value] of Object.entries(environment)) args.push('--env', `${name}=${value}`);
  args.push(image);
  run(args);
  try {
    const address = run(['port', servingContainer, '8443/tcp']).stdout.trim();
    const port = Number(address.slice(address.lastIndexOf(':') + 1));
    assert.ok(Number.isInteger(port) && port > 0, `invalid published port: ${address}`);
    const ready = await waitForReady(port, servingContainer);
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.body, '{"status":"ok"}');
    const logs = run(['logs', servingContainer]).stdout;
    assert.equal(logs.includes(password), false, 'password leaked in restored serving logs');
  } finally {
    spawnSync('docker', ['rm', '-f', servingContainer], { encoding: 'utf8' });
  }
}

async function verifyEmptyFailClosed(databaseName) {
  const denied = spawnSync('docker', [
    'run', '--name', emptyContainer, '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--network', process.env.PG_TLS_DOCKER_NETWORK,
    '--mount', `type=volume,source=${volume},target=/run/zinesh-tls,readonly`,
    ...Object.entries(servingEnvironment(databaseName)).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    image,
  ], { encoding: 'utf8', timeout: 20_000 });
  spawnSync('docker', ['rm', '-f', emptyContainer], { encoding: 'utf8' });
  assert.equal(denied.status, 1, `unmigrated serving must fail closed: ${denied.stderr}`);
  assert.match(denied.stderr, /^Persistence startup failed\r?\n$/);
  assert.equal(denied.stdout, '');
  assert.equal(denied.stderr.includes(password), false, 'password leaked in unmigrated serving logs');
}

function runtimeFor(databaseName) {
  const config = loadPostgresConfig({
    PGHOST: process.env.PGHOST,
    PGPORT: process.env.PGPORT,
    PGDATABASE: databaseName,
    PGUSER: process.env.PGUSER,
    PG_PASSWORD_FILE: process.env.PG_PASSWORD_FILE,
    PG_TLS_MODE: 'verify-full',
    PG_TLS_CA_PATH: process.env.PG_TLS_CA_PATH,
  });
  return composeRuntime(config, {
    authentication: {
      async authenticate() {
        return { ok: true, identity: { issuer: ISSUER, subject: SUBJECT } };
      },
    },
  });
}

function createCellCommand() {
  return {
    commandId: COMMAND_ID,
    cellId: CELL_ID,
    type: 'CreateCell',
    payload: {
      payer: 'backup-payer-1',
      payee: 'backup-payee-1',
      amount: 10000n,
      currency: 'TRY',
      fundingDeadline: 2_000_000,
      completionDeadline: 5_000_000,
    },
  };
}

function dumpDatabase(databaseName) {
  const dumpFd = openSync(dumpPath, 'w', 0o600);
  try {
    const result = spawnSync('docker', clientArgs(databaseName, 'pg_dump', ['-Fc']), {
      stdio: ['ignore', dumpFd, 'pipe'], timeout: 30_000,
    });
    const stderr = decode(result.stderr);
    assert.equal(result.status, 0, `pg_dump failed: ${stderr}`);
    assert.equal(stderr.includes(password), false, 'password leaked in pg_dump logs');
  } finally {
    closeSync(dumpFd);
  }
  chmodSync(dumpPath, 0o600);
}

function restoreDatabase(databaseName) {
  const result = spawnSync('docker', clientArgs(databaseName, 'pg_restore', [
    '--no-owner', '--no-acl', '-d', databaseName, '/backup/zinesh.dump',
  ], [`type=bind,source=${dumpPath},target=/backup/zinesh.dump,readonly`]), {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, `pg_restore failed: ${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes(password), false, 'password leaked in pg_restore logs');
}

function clientArgs(databaseName, entrypoint, extra, mounts = []) {
  return [
    'run', '--rm', '--network', process.env.PG_TLS_DOCKER_NETWORK,
    '--mount', `type=bind,source=${caPath},target=/tls/database-ca.pem,readonly`,
    '--mount', `type=bind,source=${pgpassPath},target=/tls/pgpass,readonly`,
    ...mounts.flatMap((mount) => ['--mount', mount]),
    '--env', `PGHOST=${process.env.PG_TLS_DOCKER_HOST}`,
    '--env', 'PGPORT=5432',
    '--env', `PGDATABASE=${databaseName}`,
    '--env', `PGUSER=${process.env.PGUSER}`,
    '--env', 'PGSSLMODE=verify-full',
    '--env', 'PGSSLROOTCERT=/tls/database-ca.pem',
    '--env', 'PGPASSFILE=/tls/pgpass',
    '--entrypoint', entrypoint,
    postgresClient,
    ...extra,
  ];
}

function servingEnvironment(databaseName) {
  return {
    PGHOST: process.env.PG_TLS_DOCKER_HOST, PGPORT: '5432', PGDATABASE: databaseName,
    PGUSER: process.env.PGUSER, PG_PASSWORD_FILE: '/run/zinesh-tls/database-password',
    PG_TLS_MODE: 'verify-full', PG_TLS_CA_PATH: '/run/zinesh-tls/database-ca.pem',
    AUTH_TRUSTED_ISSUER: 'https://issuer.backup.test', AUTH_TRUSTED_AUDIENCE: 'zinesh-backup-smoke',
    AUTH_JWKS_URL: 'https://jwks.backup.test/keys', AUTH_ALLOWED_ALGORITHM: 'RS256',
    AUTH_CLOCK_SKEW_SECONDS: '30', AUTH_JWKS_CACHE_TTL_MS: '60000', AUTH_JWKS_TIMEOUT_MS: '3000',
    HTTPS_HOST: '0.0.0.0', HTTPS_PORT: '8443', HTTP_MAX_BODY_BYTES: '65536',
    HTTP_MAX_HEADER_BYTES: '16384', HTTP_REQUEST_TIMEOUT_MS: '5000', HTTP_HEADERS_TIMEOUT_MS: '4000',
    HTTP_MAX_CONCURRENT_REQUESTS: '32', TLS_CERTIFICATE_PATH: '/run/zinesh-tls/certificate.pem',
    TLS_PRIVATE_KEY_PATH: '/run/zinesh-tls/private-key.pem', TLS_MIN_VERSION: 'TLSv1.2',
    TLS_ALLOWED_HOSTS: 'localhost', TLS_TRUSTED_PROXIES: 'NONE',
    RATE_LIMIT_PRE_AUTH_LIMIT: '100', RATE_LIMIT_PRINCIPAL_LIMIT: '100',
    RATE_LIMIT_PRE_AUTH_WINDOW_MS: '60000', RATE_LIMIT_PRINCIPAL_WINDOW_MS: '60000',
    RATE_LIMIT_RETENTION_MS: '120000', RATE_LIMIT_STORAGE_TIMEOUT_MS: '1000',
    OBSERVABILITY_INSTANCE_ID: 'backup-restore-smoke', SECURITY_LOG_RETENTION_DAYS: '30',
    SECURITY_METRIC_RETENTION_DAYS: '30', SECURITY_AUDIT_RETENTION_DAYS: '90',
    SECURITY_ALERT_WINDOW_MS: '60000', SECURITY_ALERT_AUTH_FAILURES: '10',
    SECURITY_ALERT_RATE_LIMIT_REJECTIONS: '10', SECURITY_ALERT_AUTH_DEPENDENCY_FAILURES: '5',
    SECURITY_ALERT_AUTHORIZATION_REJECTIONS: '10', SECURITY_ALERT_DISABLED_PRINCIPAL_ATTEMPTS: '5',
    SECURITY_ALERT_POSTGRES_FAILURES: '5', SECURITY_ALERT_FAIL_CLOSED: '5',
    SECURITY_ALERT_TELEMETRY_FAILURES: '5',
  };
}

function runImageMigrate(databaseName) {
  const migrateEnv = {
    PGHOST: process.env.PG_TLS_DOCKER_HOST, PGPORT: '5432', PGDATABASE: databaseName,
    PGUSER: process.env.PGUSER, PG_PASSWORD_FILE: '/run/zinesh-tls/database-password',
    PG_TLS_MODE: 'verify-full', PG_TLS_CA_PATH: '/run/zinesh-tls/database-ca.pem',
  };
  return spawnSync('docker', [
    'run', '--rm', '--name', `zinesh-backup-migrate-${suffix}`,
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--network', process.env.PG_TLS_DOCKER_NETWORK,
    '--mount', `type=volume,source=${volume},target=/run/zinesh-tls,readonly`,
    ...Object.entries(migrateEnv).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    '--entrypoint', 'node', image, 'dist/composition/migrate.js',
  ], { encoding: 'utf8', timeout: 30_000 });
}

function postgresConfig(databaseName) {
  return {
    host: process.env.PGHOST, port: Number(process.env.PGPORT), database: databaseName,
    user: process.env.PGUSER, password,
    ssl: { ca: readFileSync(process.env.PG_TLS_CA_PATH, 'utf8'), rejectUnauthorized: true },
  };
}

function pgpassLine() {
  const escaped = password.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  return `${process.env.PG_TLS_DOCKER_HOST}:5432:*:${process.env.PGUSER}:${escaped}\n`;
}

function encode(value) {
  return JSON.stringify(value, (_key, inner) => (typeof inner === 'bigint' ? `__bigint__:${inner.toString()}` : inner));
}

function decode(value) {
  if (value === null || value === undefined) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function quoteIdentifier(value) { return `"${value.replaceAll('"', '""')}"`; }

function loadTlsFixture() {
  const filename = join(__dirname, '..', 'src', 'transport', 'tls-test-certificate.ts');
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const compile = new Function('require', 'module', 'exports', '__filename', '__dirname', output);
  compile(Module.createRequire(filename), module, module.exports, filename, dirname(filename));
  return module.exports;
}

async function waitForReady(port, container) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await httpsRequest(port, '/ready');
      if (response.statusCode === 200) return response;
      lastError = new Error(`ready status ${response.statusCode}: ${response.body}`);
    } catch (error) {
      lastError = error;
    }
    const status = spawnSync('docker', ['inspect', container, '--format', '{{.State.Status}}'], { encoding: 'utf8' });
    if (status.status === 0 && status.stdout.trim() === 'exited') break;
    await delay(250);
  }
  throw new Error(`HTTPS ready failed: ${lastError}; logs=${spawnSync('docker', ['logs', container], { encoding: 'utf8' }).stdout}`);
}

function httpsRequest(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: requestPath, method: 'GET', rejectUnauthorized: false,
      headers: { host: 'localhost' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function dropDatabase(name) {
  const pool = new Pool(postgresConfig(process.env.PGDATABASE));
  try {
    await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  } finally { await pool.end(); }
}

async function cleanup() {
  spawnSync('docker', ['rm', '-f', servingContainer], { encoding: 'utf8' });
  spawnSync('docker', ['rm', '-f', emptyContainer], { encoding: 'utf8' });
  spawnSync('docker', ['rm', '-f', `zinesh-backup-migrate-${suffix}`], { encoding: 'utf8' });
  spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' });
  rmSync(directory, { recursive: true, force: true });
  if (createdSource) { createdSource = false; await dropDatabase(sourceDatabase); }
  if (createdRestored) { createdRestored = false; await dropDatabase(restoredDatabase); }
  if (createdEmpty) { createdEmpty = false; await dropDatabase(emptyDatabase); }
}

function run(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `docker ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}
