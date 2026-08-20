'use strict';

const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes, sign, X509Certificate } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const [command, fixtureArgument, stateArgument, envArgument] = process.argv.slice(2);
assert.ok(command === 'start' || command === 'stop',
  'usage: node scripts/postgres-tls-test-environment.cjs start <fixture-dir> <state-file> <env-file> | stop <state-file>');

if (command === 'stop') {
  const statePath = resolve(fixtureArgument);
  if (existsSync(statePath)) cleanup(JSON.parse(readFileSync(statePath, 'utf8')), statePath);
  process.stdout.write('PostgreSQL TLS test environment cleanup PASS\n');
} else {
  assert.ok(fixtureArgument && stateArgument && envArgument, 'start requires fixture, state and environment paths');
  start(resolve(fixtureArgument), resolve(stateArgument), resolve(envArgument));
}

function start(directory, statePath, envPath) {
  const suffix = `${process.pid}-${Date.now()}`;
  const state = { directory, containers: [], volumes: [], networks: [] };
  try {
    mkdirSync(directory, { recursive: false });
    const password = randomBytes(24).toString('base64url');
    const now = new Date();
    const validCa = certificateAuthority('Zinesh ephemeral PostgreSQL test root',
      new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 86_400_000));
    const wrongCa = certificateAuthority('Zinesh unrelated PostgreSQL test root',
      new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 86_400_000));
    const validServer = serverCertificate(validCa, ['localhost', 'postgres-tls.test'], [],
      new Date(now.getTime() - 60_000), new Date(now.getTime() + 3_600_000));
    const hostnameMismatchServer = serverCertificate(validCa, ['wrong-host.invalid'], [],
      new Date(now.getTime() - 60_000), new Date(now.getTime() + 3_600_000));
    const expiredServer = serverCertificate(validCa, ['localhost'], [],
      new Date(now.getTime() - 7_200_000), new Date(now.getTime() - 3_600_000));
    const intermediate = intermediateAuthority(validCa, 'Zinesh ephemeral missing intermediate',
      new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 86_400_000));
    const invalidChainServer = serverCertificate(intermediate, ['localhost'], [],
      new Date(now.getTime() - 60_000), new Date(now.getTime() + 3_600_000));

    writeFileSync(join(directory, 'ca.pem'), validCa.certificate, { mode: 0o600 });
    writeFileSync(join(directory, 'wrong-ca.pem'), wrongCa.certificate, { mode: 0o600 });
    writeFileSync(join(directory, 'database-password'), password, { mode: 0o600 });
    const network = `zinesh-pg-tls-${suffix}`;
    docker(['network', 'create', network]); state.networks.push(network);
    const valid = launch('valid', validServer, password, suffix, directory, state, network, 'postgres-tls.test');
    const hostnameMismatch = launch('hostname-mismatch', hostnameMismatchServer, password, suffix, directory, state);
    const expired = launch('expired', expiredServer, password, suffix, directory, state);
    const invalidChain = launch('invalid-chain', invalidChainServer, password, suffix, directory, state);
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(envPath, [
      'ZINESH_POSTGRES_TESTS=true', 'NODE_OPTIONS=--dns-result-order=ipv4first',
      'PGHOST=localhost', `PGPORT=${valid.port}`,
      'PGDATABASE=zinesh_tls_test', 'PGUSER=zinesh_tls_test',
      `PG_PASSWORD_FILE=${join(directory, 'database-password')}`,
      'PG_TLS_MODE=verify-full', `PG_TLS_CA_PATH=${join(directory, 'ca.pem')}`,
      `PG_TLS_WRONG_CA_PATH=${join(directory, 'wrong-ca.pem')}`,
      `PG_TLS_DOCKER_NETWORK=${network}`, 'PG_TLS_DOCKER_HOST=postgres-tls.test',
      `PG_TLS_HOSTNAME_MISMATCH_PORT=${hostnameMismatch.port}`,
      `PG_TLS_EXPIRED_PORT=${expired.port}`, `PG_TLS_INVALID_CHAIN_PORT=${invalidChain.port}`,
    ].join('\n') + '\n');
    process.stdout.write('PostgreSQL 16 authenticated TLS test environment PASS\n');
  } catch (error) {
    cleanup(state, statePath);
    throw error;
  }
}

function launch(kind, server, password, suffix, directory, state, network, alias) {
  const source = join(directory, kind); mkdirSync(source);
  writeFileSync(join(source, 'server.crt'), server.certificate, { mode: 0o600 });
  writeFileSync(join(source, 'server.key'), server.privateKey, { mode: 0o600 });
  writeFileSync(join(source, 'pg_hba.conf'), [
    'local all all trust',
    'hostssl all all 0.0.0.0/0 scram-sha-256',
    'hostnossl all all 0.0.0.0/0 reject',
  ].join('\n') + '\n');
  const volume = `zinesh-pg-tls-${kind}-${suffix}`;
  const container = `zinesh-pg-tls-${kind}-${suffix}`;
  docker(['volume', 'create', volume]); state.volumes.push(volume);
  docker([
    'run', '--rm', '--user', '0:0', '--mount', `type=bind,source=${source},target=/source,readonly`,
    '--mount', `type=volume,source=${volume},target=/tls`, '--entrypoint', 'sh', 'postgres:16-alpine',
    '-c', 'cp /source/* /tls/ && chown -R 70:70 /tls && chmod 600 /tls/server.key && chmod 644 /tls/server.crt /tls/pg_hba.conf',
  ]);
  docker([
    'run', '--detach', '--name', container, '--publish', '127.0.0.1::5432',
    ...(network ? ['--network', network] : []), ...(alias ? ['--network-alias', alias] : []),
    '--env', 'POSTGRES_DB=zinesh_tls_test', '--env', 'POSTGRES_USER=zinesh_tls_test',
    '--env', `POSTGRES_PASSWORD=${password}`, '--mount', `type=volume,source=${volume},target=/tls,readonly`,
    'postgres:16-alpine', '-c', 'ssl=on', '-c', 'ssl_cert_file=/tls/server.crt',
    '-c', 'ssl_key_file=/tls/server.key', '-c', 'hba_file=/tls/pg_hba.conf',
  ]);
  state.containers.push(container);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'zinesh_tls_test', '-d', 'zinesh_tls_test']);
    if (ready.status === 0) break;
    if (attempt === 39) throw new Error(`PostgreSQL TLS ${kind} instance did not become ready`);
    sleep(250);
  }
  const published = docker(['port', container, '5432/tcp']).stdout.trim();
  const port = Number(published.slice(published.lastIndexOf(':') + 1));
  assert.ok(Number.isInteger(port) && port > 0, `PostgreSQL TLS ${kind} port is invalid`);
  return { port };
}

function cleanup(state, statePath) {
  for (const container of state.containers ?? []) spawnSync('docker', ['rm', '-f', container]);
  for (const volume of state.volumes ?? []) spawnSync('docker', ['volume', 'rm', '-f', volume]);
  for (const network of state.networks ?? []) spawnSync('docker', ['network', 'rm', network]);
  if (state.directory) rmSync(state.directory, { recursive: true, force: true });
  if (statePath) rmSync(statePath, { force: true });
}

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('PostgreSQL TLS fixture Docker operation failed');
  return result;
}

function sleep(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function certificateAuthority(commonName, validFrom, validTo) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = distinguishedName(commonName);
  const certificate = issueCertificate({
    issuerName: name, subjectName: name, subjectPublicKey: keys.publicKey,
    issuerPrivateKey: keys.privateKey, validFrom, validTo,
    extensions: [basicConstraints(true), keyUsage(0x06, 1)],
  });
  assert.equal(new X509Certificate(certificate).ca, true);
  return { certificate, privateKey: keys.privateKey, name };
}

function intermediateAuthority(issuer, commonName, validFrom, validTo) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = distinguishedName(commonName);
  const certificate = issueCertificate({
    issuerName: issuer.name, subjectName: name, subjectPublicKey: keys.publicKey,
    issuerPrivateKey: issuer.privateKey, validFrom, validTo,
    extensions: [basicConstraints(true), keyUsage(0x06, 1)],
  });
  assert.equal(new X509Certificate(certificate).ca, true);
  return { certificate, privateKey: keys.privateKey, name };
}

function serverCertificate(issuer, dnsNames, ipAddresses, validFrom, validTo) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certificate = issueCertificate({
    issuerName: issuer.name, subjectName: distinguishedName(dnsNames[0] ?? ipAddresses[0] ?? 'postgres'),
    subjectPublicKey: keys.publicKey, issuerPrivateKey: issuer.privateKey, validFrom, validTo,
    extensions: [basicConstraints(false), keyUsage(0xa0, 5), extendedKeyUsageServer(), subjectAlternativeNames(dnsNames, ipAddresses)],
  });
  return { certificate, privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

function issueCertificate(options) {
  const algorithm = sequence(oid('1.2.840.113549.1.1.11'), der(0x05, Buffer.alloc(0)));
  const serial = randomBytes(16); serial[0] &= 0x7f;
  const subjectPublicKeyInfo = options.subjectPublicKey.export({ format: 'der', type: 'spki' });
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))), integer(serial), algorithm,
    options.issuerName, sequence(utcTime(options.validFrom), utcTime(options.validTo)),
    options.subjectName, subjectPublicKeyInfo, der(0xa3, sequence(...options.extensions)),
  );
  const signature = sign('RSA-SHA256', tbs, options.issuerPrivateKey);
  return pem('CERTIFICATE', sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature]))));
}

function distinguishedName(commonName) { return sequence(set(sequence(oid('2.5.4.3'), der(0x0c, Buffer.from(commonName))))); }
function extension(identifier, value, critical = false) {
  return sequence(oid(identifier), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
}
function basicConstraints(ca) { return extension('2.5.29.19', sequence(...(ca ? [der(0x01, Buffer.from([0xff]))] : [])), true); }
function keyUsage(bits, unused) { return extension('2.5.29.15', der(0x03, Buffer.from([unused, bits])), true); }
function extendedKeyUsageServer() { return extension('2.5.29.37', sequence(oid('1.3.6.1.5.5.7.3.1'))); }
function subjectAlternativeNames(dnsNames, ipAddresses) {
  const names = [
    ...dnsNames.map((name) => der(0x82, Buffer.from(name))),
    ...ipAddresses.map((address) => der(0x87, Buffer.from(address.split('.').map(Number)))),
  ];
  return extension('2.5.29.17', sequence(...names));
}
function sequence(...children) { return der(0x30, Buffer.concat(children)); }
function set(...children) { return der(0x31, Buffer.concat(children)); }
function integer(value) { return der(0x02, value[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value); }
function utcTime(value) {
  const year = String(value.getUTCFullYear() % 100).padStart(2, '0');
  const parts = [value.getUTCMonth() + 1, value.getUTCDate(), value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds()]
    .map((part) => String(part).padStart(2, '0')).join('');
  return der(0x17, Buffer.from(`${year}${parts}Z`));
}
function oid(value) {
  const parts = value.split('.').map(Number); const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    for (let remaining = Math.floor(part / 128); remaining > 0; remaining = Math.floor(remaining / 128)) encoded.unshift((remaining & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}
function der(tag, content) {
  const length = content.length < 128 ? Buffer.from([content.length]) : (() => {
    const bytes = []; for (let value = content.length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  })();
  return Buffer.concat([Buffer.from([tag]), length, content]);
}
function pem(label, content) {
  const base64 = content.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}
