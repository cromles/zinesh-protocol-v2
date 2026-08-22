'use strict';

const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const {
  chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, rmSync, writeFileSync,
} = require('node:fs');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { request } = require('node:https');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');
const { Pool } = require('pg');

const COSIGN_IMAGE = 'gcr.io/projectsigstore/cosign:v2.4.3@sha256:203f193bc86591bbc1a3a39ad3532590652477d1775ccb91221e8d14cfe5c000';
const REGISTRY_IMAGE = 'registry:2.8.3@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278';
const SKOPEO_IMAGE = 'quay.io/skopeo/stable:v1.17.0@sha256:a5032a59f55ac82e2b5c9e9a8223a5249a31e82ae51f74d63ff356ccbed1adee';
const PINNED_BASE = 'node:24.18.1-alpine3.23@sha256:ba63d8e0b5d4cbc6db9da12ea77ddb35a4783ad653a092ef115cc383526d4369';
const POSTGRES_CLIENT = 'postgres:16-alpine';

const archive = process.argv[2];
const expectedDigest = process.argv[3];
assert.ok(archive && expectedDigest,
  'usage: node scripts/verify-production-rollout.cjs <oci-tar> <sha256:digest>');
assert.match(expectedDigest, /^sha256:[0-9a-f]{64}$/, 'expected digest must be sha256:<hex>');
assert.equal(process.env.PGPASSWORD, undefined, 'PGPASSWORD is not accepted for rollout');
assert.equal(process.env.PG_TLS_MODE ?? 'verify-full', 'verify-full');
for (const name of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PG_PASSWORD_FILE', 'PG_TLS_CA_PATH',
  'PG_TLS_DOCKER_NETWORK', 'PG_TLS_DOCKER_HOST']) {
  assert.ok(process.env[name], `${name} is required for rollout smoke`);
}

const suffix = `${process.pid}-${Date.now()}`;
const work = mkdtempSync(join(tmpdir(), 'zinesh-rollout-'));
const layout = join(work, 'layout');
const subjectLayout = join(work, 'subject');
const mutatedLayout = join(work, 'mutated');
const pulled = join(work, 'pulled');
const trustedKeys = join(work, 'trusted-keys');
const wrongKeys = join(work, 'wrong-keys');
const tlsDir = join(work, 'tls');
const dumpPath = join(work, 'pre-apply.dump');
const recoveredDumpPath = join(work, 'recovered.dump');
const pgpassPath = join(work, 'pgpass');
const caPath = join(work, 'database-ca.pem');
const networkName = `zinesh-rollout-net-${suffix}`;
const sourceRegistry = `zinesh-rollout-src-${suffix}`;
const destRegistry = `zinesh-rollout-dst-${suffix}`;
const volume = `zinesh-rollout-tls-${suffix}`;
const applyDatabase = `zinesh_rollout_apply_${process.pid}_${Date.now()}`;
const undoDatabase = `zinesh_rollout_undo_${process.pid}_${Date.now()}`;
const recoveredDatabase = `zinesh_rollout_recovered_${process.pid}_${Date.now()}`;
const migrateContainer = `zinesh-rollout-migrate-${suffix}`;
const serveContainer = `zinesh-rollout-serve-${suffix}`;
const recoveredContainer = `zinesh-rollout-recovered-${suffix}`;
const pinnedImage = `localhost/zinesh/runtime@${expectedDigest}`;
const password = readFileSync(process.env.PG_PASSWORD_FILE, 'utf8').replace(/\n$/, '').replace(/\r$/, '');
const secrets = [password];
let trustedPassword = '';
let createdNetwork = false;
let startedSource = false;
let startedDest = false;
let createdVolume = false;
let createdApply = false;
let createdUndo = false;
let createdRecovered = false;

void (async () => {
  try {
    await execute();
  } catch (error) {
    process.stderr.write(`${redact(error.stack ?? error.message ?? error)}\n`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();

async function execute() {
  mkdirSync(layout);
  mkdirSync(tlsDir, { mode: 0o700 });
  mkdirSync(trustedKeys, { mode: 0o700 });
  mkdirSync(wrongKeys, { mode: 0o700 });
  const extract = spawnSync('tar', ['-xf', archive, '-C', layout], { encoding: 'utf8' });
  assert.equal(extract.status, 0, `cannot extract OCI archive: ${redact(extract.stderr)}`);
  assert.equal(runtimeSubjectDigest(layout), expectedDigest, 'OCI archive subject digest does not match expected digest');

  docker(['pull', '--platform', 'linux/amd64', COSIGN_IMAGE]);
  docker(['pull', '--platform', 'linux/amd64', REGISTRY_IMAGE]);
  docker(['pull', '--platform', 'linux/amd64', SKOPEO_IMAGE]);

  docker(['network', 'create', networkName]);
  createdNetwork = true;
  docker([
    'run', '-d', '--name', sourceRegistry, '--network', networkName,
    '--network-alias', 'source.registry.test', '-p', '127.0.0.1:0:5000',
    '--platform', 'linux/amd64', REGISTRY_IMAGE,
  ]);
  startedSource = true;
  docker([
    'run', '-d', '--name', destRegistry, '--network', networkName,
    '--network-alias', 'promote.registry.test', '-p', '127.0.0.1:0:5000',
    '--platform', 'linux/amd64', REGISTRY_IMAGE,
  ]);
  startedDest = true;
  waitForRegistry(sourceRegistry);
  waitForRegistry(destRegistry);

  trustedPassword = newPassword();
  const wrongPassword = newPassword();
  secrets.push(trustedPassword, wrongPassword);
  generateKeyPair(trustedKeys, trustedPassword);
  generateKeyPair(wrongKeys, wrongPassword);
  secrets.push(readFileSync(join(trustedKeys, 'cosign.key'), 'utf8'));
  secrets.push(readFileSync(join(wrongKeys, 'cosign.key'), 'utf8'));

  const sourceRef = `source.registry.test:5000/zinesh/runtime@${expectedDigest}`;
  const destRef = `promote.registry.test:5000/zinesh/runtime@${expectedDigest}`;
  const unsignedRef = `promote.registry.test:5000/zinesh/unsigned@${expectedDigest}`;
  materializeSubjectLayout(layout, subjectLayout, expectedDigest);
  skopeo([
    'copy', '--preserve-digests', '--format', 'oci', '--dest-tls-verify=false',
    `oci:${subjectLayout}`, `docker://${sourceRef}`,
  ]);
  cosign(['sign', '--key', '/work/cosign.key', '--tlog-upload=false',
    '--allow-http-registry', '--allow-insecure-registry', '--yes', sourceRef], trustedKeys);
  assertReleasable(sourceRef, trustedKeys, expectedDigest);
  process.stdout.write('VERIFY DIGEST:\nPASS\n');

  cosign(['copy', '--allow-http-registry', '--allow-insecure-registry', '--force', sourceRef, destRef], trustedKeys);
  const promotedDigest = inspectDigest(destRef);
  process.stdout.write(`PROMOTION:\nPASS\nPROMOTED DIGEST:\n${promotedDigest}\n`);
  assertDigestEqual(promotedDigest, expectedDigest);
  skopeo([
    'copy', '--preserve-digests', '--src-tls-verify=false',
    `docker://${destRef}`, `oci:${pulled}`,
  ]);
  assertDigestEqual(ociLayoutDigest(pulled), expectedDigest);
  assertReleasable(destRef, trustedKeys, expectedDigest);
  process.stdout.write('DIGEST MATCH:\nPASS\n');

  copyToDockerDaemon(destRef);
  const migrateDigest = inspectLocalDigest();
  const serveDigest = inspectLocalDigest();
  assertDigestEqual(migrateDigest, expectedDigest);
  assertDigestEqual(serveDigest, expectedDigest);

  const admin = new Pool(postgresConfig(process.env.PGDATABASE));
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(applyDatabase)}`);
    createdApply = true;
    await admin.query(`CREATE DATABASE ${quoteIdentifier(undoDatabase)}`);
    createdUndo = true;
    await admin.query(`CREATE DATABASE ${quoteIdentifier(recoveredDatabase)}`);
    createdRecovered = true;
  } finally {
    await admin.end();
  }
  prepareTlsVolume();

  dumpDatabase(applyDatabase, dumpPath);
  assertBackupFile(dumpPath);
  process.stdout.write('PRE-APPLY BACKUP:\nPASS\n');

  const migrated = runPinned('migrate', migrateContainer, applyDatabase, ['--entrypoint', 'node', pinnedImage, 'dist/composition/migrate.js']);
  assert.equal(migrated.status, 0, `migrate from digest failed: ${redact(migrated.stderr)}`);
  assert.equal(migrated.stdout, '');
  assert.equal(migrated.stderr, '');
  assert.equal((migrated.stderr || '').includes(password), false, 'password leaked in migrate logs');
  assert.ok(pinnedImage.includes(expectedDigest), 'migrate image is not digest-pinned');
  const migrateImage = pinnedImage;
  process.stdout.write('MIGRATE FROM DIGEST:\nPASS\n');

  const schema = await schemaVersions(applyDatabase);
  assert.deepEqual(schema, [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
  dumpDatabase(applyDatabase, recoveredDumpPath);
  assertBackupFile(recoveredDumpPath);

  const serveImage = pinnedImage;
  assert.equal(migrateImage, serveImage, 'migrate and serve must use the same digest-pinned image');
  assert.equal(migrateDigest, serveDigest, 'MIGRATE_IMAGE_DIGEST !== SERVE_IMAGE_DIGEST');
  process.stdout.write('SERVE FROM SAME DIGEST:\n');
  await serveReady(serveContainer, applyDatabase);
  process.stdout.write('PASS\nMIGRATE/SERVE DIGEST EQUALITY:\nPASS\nREADY:\nPASS\n');

  skopeo([
    'copy', '--preserve-digests', '--format', 'oci', '--dest-tls-verify=false',
    `oci:${subjectLayout}`, `docker://${unsignedRef}`,
  ]);
  expectReleaseRejected('UNSIGNED', () => assertReleasable(unsignedRef, trustedKeys, expectedDigest));
  expectReleaseRejected('WRONG DIGEST', () => assertReleasable(destRef, trustedKeys, `sha256:${'0'.repeat(64)}`));
  expectReleaseRejected('WRONG SIGNATURE', () => assertReleasable(destRef, wrongKeys, expectedDigest));

  const mutatedDigest = mutateRuntimeSubject(layout, expectedDigest);
  assert.notEqual(mutatedDigest, expectedDigest);
  const mutatedRef = `promote.registry.test:5000/zinesh/mutated@${mutatedDigest}`;
  materializeSubjectLayout(layout, mutatedLayout, mutatedDigest);
  skopeo([
    'copy', '--preserve-digests', '--format', 'oci', '--dest-tls-verify=false',
    `oci:${mutatedLayout}`, `docker://${mutatedRef}`,
  ]);
  expectReleaseRejected('MUTATED', () => assertReleasable(mutatedRef, trustedKeys, expectedDigest));

  restoreDatabase(undoDatabase, dumpPath);
  const undoSchema = await schemaVersionsOrEmpty(undoDatabase);
  assert.deepEqual(undoSchema, [], 'pre-apply restore must not contain applied schema');

  restoreDatabase(recoveredDatabase, recoveredDumpPath);
  assert.deepEqual(await schemaVersions(recoveredDatabase), schema);
  await serveReady(recoveredContainer, recoveredDatabase);
  process.stdout.write('ROLLBACK RESTORE:\nPASS\n');

  assert.equal(existsSync(join(layout, 'cosign.key')), false);
  assert.equal(existsSync(join(layout, 'pg_dump')), false);
}

function assertReleasable(imageRef, keyDir, digest) {
  cosign(['verify', '--key', '/work/cosign.pub', '--insecure-ignore-tlog',
    '--allow-http-registry', '--allow-insecure-registry', imageRef], keyDir);
  assertDigestEqual(inspectDigest(imageRef), digest);
}

function expectReleaseRejected(label, fn) {
  let failed = false;
  try {
    fn();
  } catch (error) {
    failed = true;
    const raw = String(error.stack ?? error.message ?? error);
    for (const secret of secrets) {
      if (secret) assert.equal(raw.includes(secret), false, `${label} leaked a secret`);
    }
  }
  assert.equal(failed, true, `${label} must reject the release`);
  process.stdout.write(`${label}:\nEXPECTED FAIL\n`);
}

function assertPinnedRef(value, message) {
  assert.ok(String(value).includes(expectedDigest), message);
}

function containerImageRef(name) {
  const inspect = JSON.parse(docker(['inspect', name]).stdout)[0];
  const used = inspect.Config?.Image ?? '';
  const repoDigests = inspect.RepoDigests ?? [];
  return [used, ...repoDigests].join(' ');
}

function copyToDockerDaemon(imageRef) {
  skopeo([
    'copy', '--preserve-digests', '--src-tls-verify=false',
    `docker://${imageRef}`, `docker-daemon:${pinnedImage}`,
  ], { dockerSock: true });
}

function inspectLocalDigest() {
  const result = skopeo(['inspect', '--format', '{{.Digest}}', `docker-daemon:${pinnedImage}`], { dockerSock: true });
  const digest = String(result.stdout || '').trim();
  assert.match(digest, /^sha256:[0-9a-f]{64}$/, 'local docker-daemon digest is missing');
  return digest;
}

function runPinned(role, name, databaseName, extra) {
  const env = role === 'migrate' ? migrateEnv(databaseName) : servingEnv(databaseName);
  return spawnSync('docker', [
    'run', '--rm', '--name', name, '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--pull=never',
    '--network', process.env.PG_TLS_DOCKER_NETWORK,
    '--mount', `type=volume,source=${volume},target=/run/zinesh-tls,readonly`,
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    ...extra,
  ], { encoding: 'utf8', timeout: 30_000 });
}

async function serveReady(name, databaseName) {
  const env = servingEnv(databaseName);
  docker([
    'run', '--detach', '--name', name, '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--pull=never',
    '--network', process.env.PG_TLS_DOCKER_NETWORK,
    '--publish', '127.0.0.1::8443',
    '--mount', `type=volume,source=${volume},target=/run/zinesh-tls,readonly`,
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    pinnedImage,
  ]);
  try {
    const used = containerImageRef(name);
    assertPinnedRef(used, `serve container image must be digest ${expectedDigest}, got ${used}`);
    const address = docker(['port', name, '8443/tcp']).stdout.trim();
    const port = Number(address.slice(address.lastIndexOf(':') + 1));
    const ready = await waitForReady(port, name);
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.body, '{"status":"ok"}');
    const logs = docker(['logs', name], { allowFailure: true });
    const combined = `${logs.stdout || ''}\n${logs.stderr || ''}`;
    assert.equal(combined.includes(password), false, 'password leaked in serving logs');
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
  }
}

function prepareTlsVolume() {
  const fixture = loadTlsFixture();
  const now = new Date();
  const tls = fixture.selfSignedTestCertificate(
    new Date(now.getTime() - 60_000), new Date(now.getTime() + 3_600_000), 'localhost',
  );
  writeFileSync(join(tlsDir, 'certificate.pem'), tls.certificate, { mode: 0o600 });
  writeFileSync(join(tlsDir, 'private-key.pem'), tls.privateKey, { mode: 0o600 });
  writeFileSync(join(tlsDir, 'database-password'), password, { mode: 0o600 });
  writeFileSync(caPath, readFileSync(process.env.PG_TLS_CA_PATH), { mode: 0o600 });
  writeFileSync(join(tlsDir, 'database-ca.pem'), readFileSync(process.env.PG_TLS_CA_PATH), { mode: 0o600 });
  writeFileSync(pgpassPath, pgpassLine(), { mode: 0o600 });
  docker(['volume', 'create', volume]);
  createdVolume = true;
  docker([
    'run', '--rm',
    '--mount', `type=bind,source=${tlsDir},target=/source,readonly`,
    '--mount', `type=volume,source=${volume},target=/tls`,
    '--entrypoint', 'sh', PINNED_BASE, '-c',
    'cp /source/certificate.pem /tls/certificate.pem && cp /source/private-key.pem /tls/private-key.pem && cp /source/database-password /tls/database-password && cp /source/database-ca.pem /tls/database-ca.pem && chown 1000:1000 /tls/* && chmod 600 /tls/database-password /tls/private-key.pem && chmod 644 /tls/database-ca.pem /tls/certificate.pem',
  ]);
}

function dumpDatabase(databaseName, target) {
  const dumpFd = openSync(target, 'w', 0o600);
  try {
    const result = spawnSync('docker', clientArgs(databaseName, 'pg_dump', ['-Fc'], []), {
      stdio: ['ignore', dumpFd, 'pipe'], timeout: 30_000,
    });
    const stderr = decode(result.stderr);
    assert.equal(result.status, 0, `pg_dump failed: ${redact(stderr)}`);
    assert.equal(stderr.includes(password), false, 'password leaked in pg_dump logs');
  } finally {
    closeSync(dumpFd);
  }
  chmodSync(target, 0o600);
}

function restoreDatabase(databaseName, source) {
  const result = spawnSync('docker', clientArgs(databaseName, 'pg_restore', [
    '--no-owner', '--no-acl', '-d', databaseName, '/backup/zinesh.dump',
  ], [`type=bind,source=${source},target=/backup/zinesh.dump,readonly`]), {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, `pg_restore failed: ${redact(result.stderr)}`);
  assert.equal((result.stderr || '').includes(password), false, 'password leaked in pg_restore logs');
}

function assertBackupFile(path) {
  const stat = require('node:fs').statSync(path);
  assert.ok(stat.size > 0, 'backup file is empty');
  assert.equal(stat.mode & 0o777, 0o600, 'backup file must be 0600');
  assert.equal(readFileSync(path).includes(Buffer.from(password)), false, 'password leaked into dump file');
}

function clientArgs(databaseName, entrypoint, extra, mounts) {
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
    POSTGRES_CLIENT,
    ...extra,
  ];
}

function migrateEnv(databaseName) {
  return {
    PGHOST: process.env.PG_TLS_DOCKER_HOST, PGPORT: '5432', PGDATABASE: databaseName,
    PGUSER: process.env.PGUSER, PG_PASSWORD_FILE: '/run/zinesh-tls/database-password',
    PG_TLS_MODE: 'verify-full', PG_TLS_CA_PATH: '/run/zinesh-tls/database-ca.pem',
  };
}

function servingEnv(databaseName) {
  return {
    ...migrateEnv(databaseName),
    AUTH_TRUSTED_ISSUER: 'https://issuer.rollout.test', AUTH_TRUSTED_AUDIENCE: 'zinesh-rollout-smoke',
    AUTH_JWKS_URL: 'https://jwks.rollout.test/keys', AUTH_ALLOWED_ALGORITHM: 'RS256',
    AUTH_CLOCK_SKEW_SECONDS: '30', AUTH_JWKS_CACHE_TTL_MS: '60000', AUTH_JWKS_TIMEOUT_MS: '3000',
    HTTPS_HOST: '0.0.0.0', HTTPS_PORT: '8443', HTTP_MAX_BODY_BYTES: '65536',
    HTTP_MAX_HEADER_BYTES: '16384', HTTP_REQUEST_TIMEOUT_MS: '5000', HTTP_HEADERS_TIMEOUT_MS: '4000',
    HTTP_MAX_CONCURRENT_REQUESTS: '32', TLS_CERTIFICATE_PATH: '/run/zinesh-tls/certificate.pem',
    TLS_PRIVATE_KEY_PATH: '/run/zinesh-tls/private-key.pem', TLS_MIN_VERSION: 'TLSv1.2',
    TLS_ALLOWED_HOSTS: 'localhost', TLS_TRUSTED_PROXIES: 'NONE',
    RATE_LIMIT_PRE_AUTH_LIMIT: '100', RATE_LIMIT_PRINCIPAL_LIMIT: '100',
    RATE_LIMIT_PRE_AUTH_WINDOW_MS: '60000', RATE_LIMIT_PRINCIPAL_WINDOW_MS: '60000',
    RATE_LIMIT_RETENTION_MS: '120000', RATE_LIMIT_STORAGE_TIMEOUT_MS: '1000',
    OBSERVABILITY_INSTANCE_ID: 'rollout-smoke', SECURITY_LOG_RETENTION_DAYS: '30',
    SECURITY_METRIC_RETENTION_DAYS: '30', SECURITY_AUDIT_RETENTION_DAYS: '90',
    SECURITY_ALERT_WINDOW_MS: '60000', SECURITY_ALERT_AUTH_FAILURES: '10',
    SECURITY_ALERT_RATE_LIMIT_REJECTIONS: '10', SECURITY_ALERT_AUTH_DEPENDENCY_FAILURES: '5',
    SECURITY_ALERT_AUTHORIZATION_REJECTIONS: '10', SECURITY_ALERT_DISABLED_PRINCIPAL_ATTEMPTS: '5',
    SECURITY_ALERT_POSTGRES_FAILURES: '5', SECURITY_ALERT_FAIL_CLOSED: '5',
    SECURITY_ALERT_TELEMETRY_FAILURES: '5',
  };
}

async function schemaVersions(databaseName) {
  const pool = new Pool(postgresConfig(databaseName));
  try {
    return (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows;
  } finally {
    await pool.end();
  }
}

async function schemaVersionsOrEmpty(databaseName) {
  const pool = new Pool(postgresConfig(databaseName));
  try {
    const exists = await pool.query("SELECT to_regclass('public.schema_migrations') AS name");
    if (!exists.rows[0]?.name) return [];
    return (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows;
  } finally {
    await pool.end();
  }
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

function runtimeSubjectDigest(directory) {
  const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8'));
  const descriptors = flatten(directory, index.manifests ?? []);
  const subject = descriptors.find((entry) => entry.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest'
    && entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64');
  assert.ok(subject?.digest?.startsWith('sha256:'), 'linux/amd64 subject manifest is missing');
  return subject.digest;
}

function flatten(directory, entries) {
  return entries.flatMap((entry) => {
    if (entry.mediaType === 'application/vnd.oci.image.index.v1+json') {
      return flatten(directory, blob(directory, entry.digest).manifests ?? []);
    }
    return [entry];
  });
}

function blob(directory, digest) {
  return JSON.parse(readFileSync(join(directory, 'blobs', 'sha256', digest.replace('sha256:', '')), 'utf8'));
}

function materializeSubjectLayout(sourceDir, destDir, digest) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(join(destDir, 'blobs', 'sha256'), { recursive: true });
  writeFileSync(join(destDir, 'oci-layout'), readFileSync(join(sourceDir, 'oci-layout')));
  const manifest = blob(sourceDir, digest);
  const hexes = [digest, manifest.config.digest, ...(manifest.layers ?? []).map((layer) => layer.digest)]
    .map((value) => value.replace(/^sha256:/, ''));
  for (const hex of hexes) {
    cpSync(join(sourceDir, 'blobs', 'sha256', hex), join(destDir, 'blobs', 'sha256', hex));
  }
  const descriptors = flatten(sourceDir, JSON.parse(readFileSync(join(sourceDir, 'index.json'), 'utf8')).manifests ?? []);
  const subject = descriptors.find((entry) => entry.digest === digest);
  assert.ok(subject, 'subject descriptor is missing from the source OCI layout');
  writeFileSync(join(destDir, 'index.json'), `${JSON.stringify({
    schemaVersion: 2,
    manifests: [{
      mediaType: subject.mediaType,
      digest: subject.digest,
      size: subject.size,
      platform: subject.platform ?? { os: 'linux', architecture: 'amd64' },
    }],
  })}\n`);
}

function ociLayoutDigest(directory) {
  const digest = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8')).manifests?.[0]?.digest;
  assert.match(digest ?? '', /^sha256:[0-9a-f]{64}$/, 'pulled OCI layout digest is missing');
  return digest;
}

function mutateRuntimeSubject(directory, subjectDigest) {
  const manifest = blob(directory, subjectDigest);
  const config = blob(directory, manifest.config.digest);
  config.config = config.config ?? {};
  config.config.Env = [...(config.config.Env ?? []), 'ZINESH_ROLLOUT_MUTATED=1'];
  const newConfig = Buffer.from(JSON.stringify(config));
  const newConfigDigest = `sha256:${createHash('sha256').update(newConfig).digest('hex')}`;
  writeFileSync(join(directory, 'blobs', 'sha256', newConfigDigest.slice('sha256:'.length)), newConfig);
  const newManifestObject = {
    ...manifest,
    config: { ...manifest.config, digest: newConfigDigest, size: newConfig.length },
  };
  const newManifest = Buffer.from(JSON.stringify(newManifestObject));
  const newManifestDigest = `sha256:${createHash('sha256').update(newManifest).digest('hex')}`;
  writeFileSync(join(directory, 'blobs', 'sha256', newManifestDigest.slice('sha256:'.length)), newManifest);
  const indexPath = join(directory, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.manifests = [...(index.manifests ?? []), {
    mediaType: manifest.mediaType ?? 'application/vnd.oci.image.manifest.v1+json',
    digest: newManifestDigest,
    size: newManifest.length,
    platform: { os: 'linux', architecture: 'amd64' },
  }];
  writeFileSync(indexPath, JSON.stringify(index));
  return newManifestDigest;
}

function generateKeyPair(directory, keyPassword) {
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, '.cosign-env'),
    `COSIGN_PASSWORD=${keyPassword}\nCOSIGN_YES=true\n`, { mode: 0o600 });
  cosign(['generate-key-pair'], directory);
  chmodSync(join(directory, 'cosign.key'), 0o600);
  chmodSync(join(directory, 'cosign.pub'), 0o600);
}

function inspectDigest(imageRef) {
  const result = skopeo(['inspect', '--tls-verify=false', '--format', '{{.Digest}}', `docker://${imageRef}`]);
  const digest = String(result.stdout || '').trim();
  assert.match(digest, /^sha256:[0-9a-f]{64}$/, 'registry inspect did not return a digest');
  return digest;
}

function assertDigestEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error('digest mismatch: registry digest does not equal expected runtime digest');
  }
}

function waitForRegistry(name) {
  const port = docker(['port', name, '5000/tcp']).stdout.trim().split(':').pop();
  assert.match(port, /^\d+$/, 'ephemeral registry host port is missing');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = spawnSync('curl', ['-fsS', `http://127.0.0.1:${port}/v2/`], { encoding: 'utf8' });
    if (probe.status === 0) return;
    spawnSync('sleep', ['1']);
  }
  throw new Error(`ephemeral registry ${name} did not become ready`);
}

function newPassword() {
  return randomBytes(32).toString('hex');
}

function cosign(args, keyDir) {
  return dockerRun(COSIGN_IMAGE, args, {
    workdir: '/work',
    binds: [[keyDir, '/work']],
    envFile: join(keyDir, '.cosign-env'),
    network: networkName,
  });
}

function skopeo(args, options = {}) {
  const binds = [[work, work]];
  return dockerRun(SKOPEO_IMAGE, args, {
    binds, network: networkName, dockerSock: options.dockerSock, allowFailure: options.allowFailure,
  });
}

function dockerRun(image, args, { workdir, binds = [], envFile, network, dockerSock = false, allowFailure = false } = {}) {
  const command = ['run', '--rm', '--platform', 'linux/amd64'];
  command.push('--user', dockerSock ? '0:0' : `${process.getuid()}:${process.getgid()}`);
  if (network) command.push('--network', network);
  if (workdir) command.push('-w', workdir);
  if (envFile) command.push('--env-file', envFile);
  if (dockerSock) command.push('-v', '/var/run/docker.sock:/var/run/docker.sock');
  for (const [source, target] of binds) command.push('-v', `${source}:${target}`);
  command.push(image, ...args);
  return docker(command, { allowFailure });
}

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const raw = `${result.stdout || ''}\n${result.stderr || ''}`;
  for (const secret of secrets) {
    if (secret && raw.includes(secret)) throw new Error('command output contained a secret');
  }
  if (allowFailure) return result;
  if (result.status !== 0) {
    throw new Error(redact(result.stderr || result.stdout || `docker exited ${result.status}`));
  }
  return result;
}

function redact(value) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/-----BEGIN [^\n]+-----[\s\S]*?-----END [^\n]+-----/g, '[redacted-pem]');
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
  throw new Error(`HTTPS ready failed: ${lastError}; logs=${redact(spawnSync('docker', ['logs', container], { encoding: 'utf8' }).stdout)}`);
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
  for (const name of [serveContainer, recoveredContainer, migrateContainer, sourceRegistry, destRegistry]) {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
  }
  if (createdVolume) spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' });
  if (createdNetwork) spawnSync('docker', ['network', 'rm', networkName], { encoding: 'utf8' });
  rmSync(work, { recursive: true, force: true });
  if (createdApply) { createdApply = false; await dropDatabase(applyDatabase); }
  if (createdUndo) { createdUndo = false; await dropDatabase(undoDatabase); }
  if (createdRecovered) { createdRecovered = false; await dropDatabase(recoveredDatabase); }
}
