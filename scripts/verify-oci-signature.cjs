'use strict';

const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const COSIGN_IMAGE = 'gcr.io/projectsigstore/cosign:v2.4.3@sha256:203f193bc86591bbc1a3a39ad3532590652477d1775ccb91221e8d14cfe5c000';
const REGISTRY_IMAGE = 'registry:2.8.3@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278';
const SKOPEO_IMAGE = 'quay.io/skopeo/stable:v1.17.0@sha256:a5032a59f55ac82e2b5c9e9a8223a5249a31e82ae51f74d63ff356ccbed1adee';

const archive = process.argv[2];
const expectedDigest = process.argv[3];
const handoffArgument = process.argv.find((argument) => argument.startsWith('--handoff-output='));
const handoffOutput = handoffArgument?.slice('--handoff-output='.length);
assert.ok(archive && expectedDigest,
  'usage: node scripts/verify-oci-signature.cjs <oci-tar> <sha256:digest> [--handoff-output=<json>]');
assert.match(expectedDigest, /^sha256:[0-9a-f]{64}$/, 'expected digest must be sha256:<hex>');

const suffix = `${process.pid}-${Date.now()}`;
const work = mkdtempSync(join(tmpdir(), 'zinesh-oci-trust-'));
const layout = join(work, 'layout');
const subjectLayout = join(work, 'subject');
const mutatedLayout = join(work, 'mutated');
const pulled = join(work, 'pulled');
const trustedKeys = join(work, 'trusted-keys');
const wrongKeys = join(work, 'wrong-keys');
const networkName = `zinesh-oci-trust-${suffix}`;
const registryName = `zinesh-oci-registry-${suffix}`;
const secrets = [];
let trustedPassword = '';
let wrongPassword = '';
let startedRegistry = false;
let createdNetwork = false;
let handoffReady = false;

try {
  execute();
} catch (error) {
  process.stderr.write(`${redact(error.stack ?? error.message ?? error)}\n`);
  process.exitCode = 1;
} finally {
  if (!handoffReady) cleanup();
}

function execute() {
  assertArtifactHasNoSigningMaterial(archive);
  mkdirSync(layout);
  mkdirSync(trustedKeys, { mode: 0o700 });
  mkdirSync(wrongKeys, { mode: 0o700 });
  const extract = spawnSync('tar', ['-xf', archive, '-C', layout], { encoding: 'utf8' });
  assert.equal(extract.status, 0, `cannot extract OCI archive: ${redact(extract.stderr)}`);
  const subjectDigest = runtimeSubjectDigest(layout);
  assert.equal(subjectDigest, expectedDigest, 'OCI archive subject digest does not match expected digest');

  docker(['pull', '--platform', 'linux/amd64', COSIGN_IMAGE]);
  docker(['pull', '--platform', 'linux/amd64', REGISTRY_IMAGE]);
  docker(['pull', '--platform', 'linux/amd64', SKOPEO_IMAGE]);

  docker(['network', 'create', networkName]);
  createdNetwork = true;
  docker([
    'run', '-d', '--name', registryName, '--network', networkName,
    '--network-alias', 'registry.test', '-p', '127.0.0.1:0:5000',
    '--platform', 'linux/amd64', REGISTRY_IMAGE,
  ]);
  startedRegistry = true;
  waitForRegistry();

  const runtimeRef = `registry.test:5000/zinesh/runtime@${expectedDigest}`;
  const unsignedRef = `registry.test:5000/zinesh/unsigned@${expectedDigest}`;
  const untrustedRef = `registry.test:5000/zinesh/untrusted@${expectedDigest}`;

  trustedPassword = newPassword();
  wrongPassword = newPassword();
  secrets.push(trustedPassword, wrongPassword);
  generateKeyPair(trustedKeys, trustedPassword);
  generateKeyPair(wrongKeys, wrongPassword);
  secrets.push(readFileSync(join(trustedKeys, 'cosign.key'), 'utf8'));
  secrets.push(readFileSync(join(wrongKeys, 'cosign.key'), 'utf8'));

  materializeSubjectLayout(layout, subjectLayout, expectedDigest);
  skopeo([
    'copy', '--preserve-digests', '--format', 'oci',
    '--dest-tls-verify=false', `oci:${subjectLayout}`, `docker://${runtimeRef}`,
  ]);
  cosign(['sign', '--key', '/work/cosign.key', '--tlog-upload=false',
    '--allow-http-registry', '--allow-insecure-registry', '--yes', runtimeRef], trustedKeys);
  skopeo([
    'copy', '--preserve-digests', '--src-tls-verify=false',
    `docker://${runtimeRef}`, `oci:${pulled}`,
  ]);
  const pulledDigest = ociLayoutDigest(pulled);
  const inspected = inspectDigest(runtimeRef);
  assertDigestEqual(inspected, expectedDigest);
  assertDigestEqual(pulledDigest, expectedDigest);
  cosign(['verify', '--key', '/work/cosign.pub', '--insecure-ignore-tlog',
    '--allow-http-registry', '--allow-insecure-registry', runtimeRef], trustedKeys);

  process.stdout.write([
    'SIGN:', 'PASS',
    'REGISTRY PUSH:', 'PASS',
    'REGISTRY PULL:', 'PASS',
    'DIGEST MATCH:', 'PASS',
    'VERIFY:', 'PASS',
  ].join('\n') + '\n');

  skopeo([
    'copy', '--preserve-digests', '--format', 'oci', '--dest-tls-verify=false',
    `oci:${subjectLayout}`, `docker://${unsignedRef}`,
  ]);
  expectVerifyFailure('UNSIGNED', unsignedRef, trustedKeys);
  expectVerifyFailure('WRONG KEY', runtimeRef, wrongKeys);
  skopeo([
    'copy', '--preserve-digests', '--format', 'oci', '--dest-tls-verify=false',
    `oci:${subjectLayout}`, `docker://${untrustedRef}`,
  ]);
  cosign(['sign', '--key', '/work/cosign.key', '--tlog-upload=false',
    '--allow-http-registry', '--allow-insecure-registry', '--yes', untrustedRef], wrongKeys);
  expectVerifyFailure('UNTRUSTED SIGNATURE', untrustedRef, trustedKeys);

  const mutatedDigest = mutateRuntimeSubject(layout, expectedDigest);
  assert.notEqual(mutatedDigest, expectedDigest, 'mutated manifest digest must differ from the signed digest');
  const mutatedRef = `registry.test:5000/zinesh/mutated@${mutatedDigest}`;
  materializeSubjectLayout(layout, mutatedLayout, mutatedDigest);
  skopeo([
    'copy', '--preserve-digests', '--format', 'oci', '--dest-tls-verify=false',
    `oci:${mutatedLayout}`, `docker://${mutatedRef}`,
  ]);
  const sigTag = `sha256-${expectedDigest.slice('sha256:'.length)}.sig`;
  const mutatedSigTag = `sha256-${mutatedDigest.slice('sha256:'.length)}.sig`;
  skopeo([
    'copy', '--src-tls-verify=false', '--dest-tls-verify=false',
    `docker://registry.test:5000/zinesh/runtime:${sigTag}`,
    `docker://registry.test:5000/zinesh/mutated:${mutatedSigTag}`,
  ], { allowFailure: true });
  expectVerifyFailure('MUTATED', mutatedRef, trustedKeys);

  expectFailure('DIGEST MISMATCH', () => {
    assertDigestEqual(pulledDigest, `sha256:${'0'.repeat(64)}`);
  });

  assert.equal(existsSync(join(layout, 'cosign.key')), false);
  assert.equal(existsSync(join(layout, 'cosign.pub')), false);

  if (handoffOutput) {
    const manifest = blob(layout, expectedDigest);
    const signatureTag = `sha256-${expectedDigest.slice('sha256:'.length)}.sig`;
    for (const directory of [trustedKeys, wrongKeys]) {
      rmSync(join(directory, 'cosign.key'), { force: true });
      rmSync(join(directory, '.cosign-env'), { force: true });
    }
    const handoff = {
      version: 1,
      verification: 'cosign-key-verified',
      artifact: {
        archiveSha256: `sha256:${createHash('sha256').update(readFileSync(archive)).digest('hex')}`,
        reference: runtimeRef,
        untrustedReference: untrustedRef,
        digest: expectedDigest,
        configDigest: manifest.config.digest,
        signatureReference: `registry.test:5000/zinesh/runtime:${signatureTag}`,
      },
      trust: {
        type: 'cosign-public-key',
        publicKeyPath: join(trustedKeys, 'cosign.pub'),
        untrustedPublicKeyPath: join(wrongKeys, 'cosign.pub'),
        cosignImage: COSIGN_IMAGE,
      },
      transport: { networkName, registryName },
      cleanup: { workDirectory: work },
    };
    writeFileSync(handoffOutput, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
    handoffReady = true;
    process.stdout.write('VERIFICATION HANDOFF:\nPASS\n');
  }
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
  const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8'));
  const manifests = index.manifests ?? [];
  assert.equal(manifests.length >= 1, true, 'pulled OCI layout has no manifests');
  const digest = manifests[0]?.digest;
  assert.match(digest ?? '', /^sha256:[0-9a-f]{64}$/, 'pulled OCI layout digest is missing');
  return digest;
}

function mutateRuntimeSubject(directory, subjectDigest) {
  const manifest = blob(directory, subjectDigest);
  const config = blob(directory, manifest.config.digest);
  config.config = config.config ?? {};
  config.config.Env = [...(config.config.Env ?? []), 'ZINESH_MUTATED=1'];
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

function generateKeyPair(directory, password) {
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, '.cosign-env'),
    `COSIGN_PASSWORD=${password}\nCOSIGN_YES=true\n`, { mode: 0o600 });
  cosign(['generate-key-pair'], directory);
  chmodSync(join(directory, 'cosign.key'), 0o600);
  chmodSync(join(directory, 'cosign.pub'), 0o600);
  const privateKey = readFileSync(join(directory, 'cosign.key'), 'utf8');
  const publicKey = readFileSync(join(directory, 'cosign.pub'), 'utf8');
  assert.match(privateKey, /BEGIN ENCRYPTED COSIGN PRIVATE KEY|BEGIN .*PRIVATE KEY/);
  assert.match(publicKey, /BEGIN PUBLIC KEY/);
  assert.equal(/BEGIN .*PRIVATE KEY/.test(publicKey), false);
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

function expectVerifyFailure(label, imageRef, keyDir) {
  expectFailure(label, () => {
    cosign(['verify', '--key', '/work/cosign.pub', '--insecure-ignore-tlog',
      '--allow-http-registry', '--allow-insecure-registry', imageRef], keyDir);
  });
}

function expectFailure(label, fn) {
  let failed = false;
  try {
    fn();
  } catch (error) {
    failed = true;
    const raw = String(error.stack ?? error.message ?? error);
    for (const secret of secrets) {
      if (secret) assert.equal(raw.includes(secret), false, `${label} leaked a signing secret`);
    }
  }
  assert.equal(failed, true, `${label} must fail closed`);
  process.stdout.write(`${label}:\nEXPECTED FAIL\n`);
}

function waitForRegistry() {
  const port = docker(['port', registryName, '5000/tcp']).stdout.trim().split(':').pop();
  assert.match(port, /^\d+$/, 'ephemeral registry host port is missing');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = spawnSync('curl', ['-fsS', `http://127.0.0.1:${port}/v2/`], { encoding: 'utf8' });
    if (probe.status === 0) return;
    spawnSync('sleep', ['1']);
  }
  throw new Error('ephemeral registry did not become ready');
}

function newPassword() {
  return randomBytes(32).toString('hex');
}

function assertArtifactHasNoSigningMaterial(path) {
  const listing = spawnSync('tar', ['-tf', path], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  assert.equal(listing.status, 0, `cannot list OCI archive: ${redact(listing.stderr)}`);
  const names = listing.stdout.split('\n');
  assert.equal(names.some((name) => /(^|\/)(cosign(?:\.key|\.pub)?|config\.json)$/i.test(name)), false,
    'OCI archive must not contain Cosign or registry credential files');
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
  return dockerRun(SKOPEO_IMAGE, args, { binds, network: networkName, allowFailure: options.allowFailure });
}

function dockerRun(image, args, { workdir, binds = [], envFile, network, allowFailure = false } = {}) {
  const command = ['run', '--rm', '--platform', 'linux/amd64',
    '--user', `${process.getuid()}:${process.getgid()}`];
  if (network) command.push('--network', network);
  if (workdir) command.push('-w', workdir);
  if (envFile) command.push('--env-file', envFile);
  for (const [source, target] of binds) command.push('-v', `${source}:${target}`);
  command.push(image, ...args);
  return docker(command, { allowFailure });
}

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const raw = `${result.stdout || ''}\n${result.stderr || ''}`;
  for (const secret of secrets) {
    if (secret && raw.includes(secret)) {
      throw new Error('command output contained a signing secret');
    }
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

function cleanup() {
  if (startedRegistry) spawnSync('docker', ['rm', '-f', registryName], { encoding: 'utf8' });
  if (createdNetwork) spawnSync('docker', ['network', 'rm', networkName], { encoding: 'utf8' });
  rmSync(work, { recursive: true, force: true });
}
