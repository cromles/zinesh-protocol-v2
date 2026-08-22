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

const image = process.argv[2];
assert.ok(image, 'usage: node scripts/verify-container-startup.cjs <image>');
for (const name of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PG_PASSWORD_FILE', 'PG_TLS_CA_PATH',
  'PG_TLS_DOCKER_NETWORK', 'PG_TLS_DOCKER_HOST']) {
  assert.ok(process.env[name], `${name} is required for container startup smoke`);
}

const suffix = `${process.pid}-${Date.now()}`;
const database = `zinesh_artifact_smoke_${process.pid}_${Date.now()}`;
const container = `zinesh-artifact-smoke-${suffix}`;
const hang = `zinesh-jwks-hang-${suffix}`;
const volume = `zinesh-artifact-tls-${suffix}`;
const directory = mkdtempSync(join(tmpdir(), 'zinesh-artifact-tls-'));
const base = 'node:24.18.1-alpine3.23@sha256:ba63d8e0b5d4cbc6db9da12ea77ddb35a4783ad653a092ef115cc383526d4369';
let createdDatabase = false;
let unmigratedDatabase = '';

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

  const fixture = loadTlsFixture();
  const now = new Date();
  const tls = fixture.selfSignedTestCertificate(
    new Date(now.getTime() - 60_000), new Date(now.getTime() + 3_600_000), 'localhost',
  );
  writeFileSync(join(directory, 'certificate.pem'), tls.certificate, { mode: 0o600 });
  writeFileSync(join(directory, 'private-key.pem'), tls.privateKey, { mode: 0o600 });
  writeFileSync(join(directory, 'database-password'), readFileSync(process.env.PG_PASSWORD_FILE), { mode: 0o600 });
  writeFileSync(join(directory, 'database-ca.pem'), readFileSync(process.env.PG_TLS_CA_PATH), { mode: 0o600 });

  run(['volume', 'create', volume]);
  run([
    'run', '--rm',
    '--mount', `type=bind,source=${directory},target=/source,readonly`,
    '--mount', `type=volume,source=${volume},target=/tls`,
    '--entrypoint', 'sh', base, '-c',
    'cp /source/certificate.pem /tls/certificate.pem && cp /source/private-key.pem /tls/private-key.pem && cp /source/database-password /tls/database-password && cp /source/database-ca.pem /tls/database-ca.pem && chown 1000:1000 /tls/* && chmod 600 /tls/database-password /tls/private-key.pem && chmod 644 /tls/database-ca.pem /tls/certificate.pem',
  ]);

  const firstApply = runImageMigrate(database);
  assert.equal(firstApply.status, 0, `in-image schema apply failed: ${firstApply.stderr}`);
  assert.equal(firstApply.stdout, '');
  assert.equal(firstApply.stderr, '');
  const secondApply = runImageMigrate(database);
  assert.equal(secondApply.status, 0, `idempotent in-image schema apply failed: ${secondApply.stderr}`);
  const smokePool = new Pool(postgresConfig(database));
  try {
    assert.deepEqual(
      (await smokePool.query('SELECT version FROM schema_migrations ORDER BY version')).rows,
      [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }],
    );
  } finally {
    await smokePool.end();
  }

  const environment = {
    PGHOST: process.env.PG_TLS_DOCKER_HOST, PGPORT: '5432', PGDATABASE: database,
    PGUSER: process.env.PGUSER, PG_PASSWORD_FILE: '/run/zinesh-tls/database-password',
    PG_TLS_MODE: 'verify-full', PG_TLS_CA_PATH: '/run/zinesh-tls/database-ca.pem',
    AUTH_TRUSTED_ISSUER: 'https://issuer.artifact.test', AUTH_TRUSTED_AUDIENCE: 'zinesh-artifact-smoke',
    AUTH_JWKS_URL: 'https://jwks.artifact.test/keys', AUTH_ALLOWED_ALGORITHM: 'RS256',
    AUTH_CLOCK_SKEW_SECONDS: '30', AUTH_JWKS_CACHE_TTL_MS: '60000', AUTH_JWKS_TIMEOUT_MS: '3000',
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
    '--security-opt=no-new-privileges:true', '--network', process.env.PG_TLS_DOCKER_NETWORK,
    '--publish', '127.0.0.1::8443',
    '--mount', `type=volume,source=${volume},target=/run/zinesh-tls,readonly`,
  ];
  for (const [name, value] of Object.entries(environment)) args.push('--env', `${name}=${value}`);
  args.push(image);

  run([
    'run', '--detach', '--name', hang,
    '--network', process.env.PG_TLS_DOCKER_NETWORK,
    '--network-alias', 'jwks.artifact.test',
    '--entrypoint', 'node', base, '-e',
    'require("net").createServer((socket) => { socket.on("error", () => undefined); }).listen(443);',
  ]);
  assert.equal(run(['inspect', hang, '--format', '{{.State.Running}}']).stdout.trim(), 'true');
  run(args);

  try {
    const inspect = JSON.parse(run(['inspect', container]).stdout)[0];
    assert.equal(inspect.Config.User, '1000:1000');
    assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
    const tlsMount = inspect.Mounts.find((mount) => mount.Destination === '/run/zinesh-tls');
    assert.ok(tlsMount, 'canonical /run/zinesh-tls mount is missing');
    assert.equal(tlsMount.RW, false, 'secret/TLS mount must be read-only');

    const identity = run([
      'exec', container, 'node', '-e',
      'const fs=require("fs"); const s=(p)=>fs.statSync(p); const pw=s("/run/zinesh-tls/database-password"); const key=s("/run/zinesh-tls/private-key.pem"); const ca=s("/run/zinesh-tls/database-ca.pem"); const cert=s("/run/zinesh-tls/certificate.pem"); if (process.getuid()!==1000 || process.getgid()!==1000) process.exit(2); if ((pw.mode & 0o777) !== 0o600 || (key.mode & 0o777) !== 0o600) process.exit(3); if ((ca.mode & 0o022) !== 0 || (cert.mode & 0o022) !== 0) process.exit(4); process.stdout.write("runtime-mount-ok");',
    ]).stdout.trim();
    assert.equal(identity, 'runtime-mount-ok');

    const address = run(['port', container, '8443/tcp']).stdout.trim();
    const port = Number(address.slice(address.lastIndexOf(':') + 1));
    assert.ok(Number.isInteger(port) && port > 0, `invalid published port: ${address}`);
    const response = await waitForHttps(port);
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /"NOT_FOUND"/);
    const live = await httpsRequest(port, '/live');
    assert.equal(live.statusCode, 200);
    assert.equal(live.body, '{"status":"ok"}');
    const ready = await httpsRequest(port, '/ready');
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.body, '{"status":"ok"}');
    const root = await httpsRequest(port, '/');
    assert.equal(root.statusCode, 404);
    const queried = await httpsRequest(port, '/ready?x=1');
    assert.equal(queried.statusCode, 404);
    assert.match(queried.body, /"NOT_FOUND"/);
    await delay(100);
    const logs = run(['logs', container]).stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.ok(logs.some((line) => { try { JSON.parse(line); return true; } catch { return false; } }),
      'container did not emit JSON logging');
    const password = readFileSync(process.env.PG_PASSWORD_FILE, 'utf8');
    assert.equal(run(['logs', container]).stdout.includes(password), false, 'password leaked in success logs');
    httpsPostCommands(port);
    await delay(150);
    run(['kill', '-s', 'SIGTERM', container]);
    let observedDrain = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const liveDrain = await httpsRequest(port, '/live');
        const readyDrain = await httpsRequest(port, '/ready');
        if (liveDrain.statusCode === 200 && liveDrain.body === '{"status":"ok"}'
          && readyDrain.statusCode === 503 && readyDrain.body === '{"status":"unavailable"}') {
          assert.equal(readyDrain.body.includes('schema'), false);
          assert.equal(readyDrain.body.includes(password), false);
          observedDrain = true;
          break;
        }
      } catch {
        // The process may close the listener after drain completes.
      }
      await delay(50);
    }
    assert.equal(observedDrain, true, 'did not observe live=200 and ready=503 during drain');
    const wait = spawnSync('docker', ['wait', container], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(wait.status, 0, `docker wait failed: ${wait.stderr}`);
    const state = JSON.parse(run(['inspect', container, '--format', '{{json .State}}']).stdout);
    assert.equal(state.ExitCode, 0, `SIGTERM shutdown exit code was ${state.ExitCode}`);
    assert.equal(state.OOMKilled, false);

    run(['rm', '-f', container]);
    run([
      'run', '--rm', '--mount', `type=volume,source=${volume},target=/tls`,
      '--entrypoint', 'sh', base, '-c', 'chmod 644 /tls/database-password',
    ]);
    const denied = spawnSync('docker', [
      'run', '--name', `${container}-world-readable`, '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true', '--network', process.env.PG_TLS_DOCKER_NETWORK,
      '--mount', `type=volume,source=${volume},target=/run/zinesh-tls,readonly`,
      ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
      image,
    ], { encoding: 'utf8', timeout: 15_000 });
    spawnSync('docker', ['rm', '-f', `${container}-world-readable`], { encoding: 'utf8' });
    assert.equal(denied.status, 1, `world-readable password must fail closed: ${denied.stderr}`);
    assert.match(denied.stderr, /^Invalid configuration: PG_PASSWORD_FILE /);
    assert.equal(denied.stdout, '');
    assert.equal(denied.stderr.includes(password), false, 'password leaked in permission-denial logs');

    unmigratedDatabase = `zinesh_unmigrated_${process.pid}_${Date.now()}`;
    const adminUnmigrated = new Pool(postgresConfig(process.env.PGDATABASE));
    try {
      await adminUnmigrated.query(`CREATE DATABASE ${quoteIdentifier(unmigratedDatabase)}`);
    } finally {
      await adminUnmigrated.end();
    }
    run([
      'run', '--rm', '--mount', `type=volume,source=${volume},target=/tls`,
      '--entrypoint', 'sh', base, '-c', 'chmod 600 /tls/database-password',
    ]);
    const unmigrated = spawnSync('docker', [
      'run', '--name', `${container}-unmigrated`, '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true', '--network', process.env.PG_TLS_DOCKER_NETWORK,
      '--mount', `type=volume,source=${volume},target=/run/zinesh-tls,readonly`,
      ...Object.entries({ ...environment, PGDATABASE: unmigratedDatabase })
        .flatMap(([name, value]) => ['--env', `${name}=${value}`]),
      image,
    ], { encoding: 'utf8', timeout: 20_000 });
    spawnSync('docker', ['rm', '-f', `${container}-unmigrated`], { encoding: 'utf8' });
    assert.equal(unmigrated.status, 1, `unmigrated serving must fail closed: ${unmigrated.stderr}`);
    assert.match(unmigrated.stderr, /^Persistence startup failed\r?\n$/);
    assert.equal(unmigrated.stdout, '');
    assert.equal(unmigrated.stderr.includes(password), false, 'password leaked in unmigrated serving logs');

    process.stdout.write('Container startup and SIGTERM smoke PASS\n');
  } finally {
    await cleanup();
  }
}

function postgresConfig(databaseName) {
  return {
    host: process.env.PGHOST, port: Number(process.env.PGPORT), database: databaseName,
    user: process.env.PGUSER, password: readFileSync(process.env.PG_PASSWORD_FILE, 'utf8'),
    ssl: { ca: readFileSync(process.env.PG_TLS_CA_PATH, 'utf8'), rejectUnauthorized: true },
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
    try { return await httpsRequest(port, '/'); } catch (error) { lastError = error; await delay(250); }
    const status = spawnSync('docker', ['inspect', container, '--format', '{{.State.Status}}'], { encoding: 'utf8' });
    if (status.status === 0 && status.stdout.trim() === 'exited') break;
  }
  throw new Error(`HTTPS startup failed: ${lastError}; logs=${spawnSync('docker', ['logs', container], { encoding: 'utf8' }).stdout}`);
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

function httpsPostCommands(port) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'smoke-key' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: 'https://issuer.artifact.test', sub: 'smoke-subject', aud: 'zinesh-artifact-smoke',
    exp: Math.floor(Date.now() / 1000) + 300,
  })).toString('base64url');
  const token = `${header}.${claims}.not-a-signature`;
  const req = request({ hostname: '127.0.0.1', port, path: '/commands', method: 'POST', rejectUnauthorized: false,
    headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
  () => undefined);
  req.on('error', () => undefined);
  req.end(JSON.stringify({
    command: {
      commandId: 'smoke-drain', cellId: 'smoke-drain-cell', type: 'CreateCell',
      payload: {
        payer: 'payer-1', payee: 'payee-1', amount: '10000', currency: 'TRY',
        fundingDeadline: 2_000_000, completionDeadline: 5_000_000,
      },
    },
  }));
}

function runImageMigrate(databaseName) {
  const migrateEnv = {
    PGHOST: process.env.PG_TLS_DOCKER_HOST, PGPORT: '5432', PGDATABASE: databaseName,
    PGUSER: process.env.PGUSER, PG_PASSWORD_FILE: '/run/zinesh-tls/database-password',
    PG_TLS_MODE: 'verify-full', PG_TLS_CA_PATH: '/run/zinesh-tls/database-ca.pem',
  };
  return spawnSync('docker', [
    'run', '--rm', '--name', `${container}-migrate`,
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--network', process.env.PG_TLS_DOCKER_NETWORK,
    '--mount', `type=volume,source=${volume},target=/run/zinesh-tls,readonly`,
    ...Object.entries(migrateEnv).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    '--entrypoint', 'node', image, 'dist/composition/migrate.js',
  ], { encoding: 'utf8', timeout: 30_000 });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function cleanup() {
  spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
  spawnSync('docker', ['rm', '-f', hang], { encoding: 'utf8' });
  spawnSync('docker', ['rm', '-f', `${container}-world-readable`], { encoding: 'utf8' });
  spawnSync('docker', ['rm', '-f', `${container}-migrate`], { encoding: 'utf8' });
  spawnSync('docker', ['rm', '-f', `${container}-unmigrated`], { encoding: 'utf8' });
  spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' });
  rmSync(directory, { recursive: true, force: true });
  if (createdDatabase) { createdDatabase = false; await dropDatabase(database); }
  if (unmigratedDatabase) {
    const name = unmigratedDatabase;
    unmigratedDatabase = '';
    await dropDatabase(name);
  }
}
function run(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `docker ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}
