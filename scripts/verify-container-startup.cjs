'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { request } = require('node:https');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');
const { Pool } = require('pg');
const { PostgresMigrator } = require('../dist/adapters/postgres-migrator');

const image = process.argv[2];
assert.ok(image, 'usage: node scripts/verify-container-startup.cjs <image>');
for (const name of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
  assert.ok(process.env[name], `${name} is required for container startup smoke`);
}

const suffix = `${process.pid}-${Date.now()}`;
const database = `zinesh_artifact_smoke_${process.pid}_${Date.now()}`;
const container = `zinesh-artifact-smoke-${suffix}`;
const volume = `zinesh-artifact-tls-${suffix}`;
const directory = mkdtempSync(join(tmpdir(), 'zinesh-artifact-tls-'));
const base = 'node:24.18.1-alpine3.23@sha256:ba63d8e0b5d4cbc6db9da12ea77ddb35a4783ad653a092ef115cc383526d4369';
let createdDatabase = false;

void execute().catch(async (error) => {
  await cleanup();
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

async function execute() {
  const admin = new Pool(postgresConfig(process.env.PGDATABASE));
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    createdDatabase = true;
  } finally {
    await admin.end();
  }

  const smokePool = new Pool(postgresConfig(database));
  try {
    const migrator = new PostgresMigrator(smokePool);
    await migrator.migrate();
    await migrator.verifyExpectedVersion();
  } finally {
    await smokePool.end();
  }

  const fixture = loadTlsFixture();
  const now = new Date();
  const tls = fixture.selfSignedTestCertificate(
    new Date(now.getTime() - 60_000), new Date(now.getTime() + 3_600_000), 'localhost',
  );
  writeFileSync(join(directory, 'certificate.pem'), tls.certificate, { mode: 0o600 });
  writeFileSync(join(directory, 'private-key.pem'), tls.privateKey, { mode: 0o600 });
  writeFileSync(join(directory, 'database-password'), process.env.PGPASSWORD, { mode: 0o600 });

  run(['volume', 'create', volume]);
  run([
    'run', '--rm',
    '--mount', `type=bind,source=${directory},target=/source,readonly`,
    '--mount', `type=volume,source=${volume},target=/tls`,
    '--entrypoint', 'sh', base, '-c',
    'cp /source/certificate.pem /tls/certificate.pem && cp /source/private-key.pem /tls/private-key.pem && cp /source/database-password /tls/database-password && chown 1000:1000 /tls/* && chmod 600 /tls/*',
  ]);

  const environment = {
    PGHOST: 'host.docker.internal', PGPORT: process.env.PGPORT, PGDATABASE: database,
    PGUSER: process.env.PGUSER, PG_PASSWORD_FILE: '/run/zinesh-tls/database-password',
    PG_TLS_MODE: 'verify-full', PG_TLS_CA_PATH: '/run/zinesh-tls/certificate.pem',
    AUTH_TRUSTED_ISSUER: 'https://issuer.artifact.test', AUTH_TRUSTED_AUDIENCE: 'zinesh-artifact-smoke',
    AUTH_JWKS_URL: 'https://jwks.artifact.test/keys', AUTH_ALLOWED_ALGORITHM: 'RS256',
    AUTH_CLOCK_SKEW_SECONDS: '30', AUTH_JWKS_CACHE_TTL_MS: '60000', AUTH_JWKS_TIMEOUT_MS: '1000',
    HTTPS_HOST: '0.0.0.0', HTTPS_PORT: '8443', HTTP_MAX_BODY_BYTES: '65536',
    HTTP_MAX_HEADER_BYTES: '16384', HTTP_REQUEST_TIMEOUT_MS: '5000', HTTP_HEADERS_TIMEOUT_MS: '4000',
    HTTP_MAX_CONCURRENT_REQUESTS: '32', TLS_CERTIFICATE_PATH: '/run/zinesh-tls/certificate.pem',
    TLS_PRIVATE_KEY_PATH: '/run/zinesh-tls/private-key.pem', TLS_MIN_VERSION: 'TLSv1.2',
    TLS_ALLOWED_HOSTS: 'localhost', TLS_TRUSTED_PROXIES: 'NONE',
    RATE_LIMIT_PRE_AUTH_LIMIT: '100', RATE_LIMIT_PRINCIPAL_LIMIT: '100',
    RATE_LIMIT_PRE_AUTH_WINDOW_MS: '60000', RATE_LIMIT_PRINCIPAL_WINDOW_MS: '60000',
    RATE_LIMIT_RETENTION_MS: '120000', RATE_LIMIT_STORAGE_TIMEOUT_MS: '1000',
    OBSERVABILITY_INSTANCE_ID: 'artifact-smoke', SECURITY_LOG_RETENTION_DAYS: '30',
    SECURITY_METRIC_RETENTION_DAYS: '30', SECURITY_AUDIT_RETENTION_DAYS: '90',
    SECURITY_ALERT_WINDOW_MS: '60000', SECURITY_ALERT_AUTH_FAILURES: '10',
    SECURITY_ALERT_RATE_LIMIT_REJECTIONS: '10', SECURITY_ALERT_AUTH_DEPENDENCY_FAILURES: '5',
    SECURITY_ALERT_AUTHORIZATION_REJECTIONS: '10', SECURITY_ALERT_DISABLED_PRINCIPAL_ATTEMPTS: '5',
    SECURITY_ALERT_POSTGRES_FAILURES: '5', SECURITY_ALERT_FAIL_CLOSED: '5',
    SECURITY_ALERT_TELEMETRY_FAILURES: '5',
  };
  const args = [
    'run', '--detach', '--name', container, '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--add-host=host.docker.internal:host-gateway',
    '--publish', '127.0.0.1::8443',
    '--mount', `type=volume,source=${volume},target=/run/zinesh-tls,readonly`,
  ];
  for (const [name, value] of Object.entries(environment)) args.push('--env', `${name}=${value}`);
  args.push(image);
  run(args);

  try {
    const address = run(['port', container, '8443/tcp']).stdout.trim();
    const port = Number(address.slice(address.lastIndexOf(':') + 1));
    assert.ok(Number.isInteger(port) && port > 0, `invalid published port: ${address}`);
    const response = await waitForHttps(port);
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /"NOT_FOUND"/);
    await delay(100);
    const logs = run(['logs', container]).stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.ok(logs.some((line) => { try { JSON.parse(line); return true; } catch { return false; } }),
      'container did not emit JSON logging');
    run(['stop', '--time', '15', container]);
    const state = JSON.parse(run(['inspect', container, '--format', '{{json .State}}']).stdout);
    assert.equal(state.ExitCode, 0, `SIGTERM shutdown exit code was ${state.ExitCode}`);
    assert.equal(state.OOMKilled, false);
    process.stdout.write('Container startup and SIGTERM smoke PASS\n');
  } finally {
    await cleanup();
  }
}

function postgresConfig(databaseName) {
  return {
    host: process.env.PGHOST, port: Number(process.env.PGPORT), database: databaseName,
    user: process.env.PGUSER, password: process.env.PGPASSWORD,
  };
}

async function dropDatabase(name) {
  const pool = new Pool(postgresConfig(process.env.PGDATABASE));
  try {
    await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  } finally { await pool.end(); }
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

async function waitForHttps(port) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await httpsGet(port); } catch (error) { lastError = error; await delay(250); }
    const status = spawnSync('docker', ['inspect', container, '--format', '{{.State.Status}}'], { encoding: 'utf8' });
    if (status.status === 0 && status.stdout.trim() === 'exited') break;
  }
  throw new Error(`HTTPS startup failed: ${lastError}; logs=${spawnSync('docker', ['logs', container], { encoding: 'utf8' }).stdout}`);
}

function httpsGet(port) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/', method: 'GET', rejectUnauthorized: false,
      headers: { host: 'localhost' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function cleanup() {
  spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
  spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' });
  rmSync(directory, { recursive: true, force: true });
  if (createdDatabase) { createdDatabase = false; await dropDatabase(database); }
}
function run(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `docker ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}
