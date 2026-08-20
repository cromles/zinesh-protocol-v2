'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const archive = process.argv[2];
const digestOnly = process.argv.includes('--digest-only');
const sbomOutputArgument = process.argv.find((entry) => entry.startsWith('--sbom-output='));
const sbomOutput = sbomOutputArgument?.slice('--sbom-output='.length);
const metadataOutputArgument = process.argv.find((entry) => entry.startsWith('--metadata-output='));
const metadataOutput = metadataOutputArgument?.slice('--metadata-output='.length);
assert.ok(archive,
  'usage: node scripts/verify-oci-artifact.cjs <archive> [--digest-only] [--sbom-output=<path>] [--metadata-output=<path>]');
const directory = mkdtempSync(join(tmpdir(), 'zinesh-oci-'));

try {
  const extract = spawnSync('tar', ['-xf', archive, '-C', directory], { encoding: 'utf8' });
  assert.equal(extract.status, 0, `cannot extract OCI archive: ${extract.stderr}`);
  const index = json('index.json');
  const descriptors = flatten(index.manifests);
  const subject = descriptors.find((entry) =>
    entry.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest'
      && entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64');
  assert.ok(subject?.digest?.startsWith('sha256:'), 'linux/amd64 subject manifest is missing');
  const subjectManifest = blob(subject.digest);
  if (digestOnly) {
    process.stdout.write(`${subject.digest}\n`);
    process.exit(0);
  }

  const statements = [];
  const attestationSubjects = [];
  for (const descriptor of descriptors.filter((entry) =>
    entry.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest')) {
    const manifest = blob(descriptor.digest);
    if (manifest.subject?.digest !== undefined) attestationSubjects.push(manifest.subject.digest);
    for (const layer of manifest.layers ?? []) statements.push(blob(layer.digest));
  }
  const sbom = statements.find((entry) => String(entry.predicateType).toLowerCase().includes('spdx'));
  const provenance = statements.find((entry) => String(entry.predicateType).toLowerCase().includes('slsa'));
  assert.ok(sbom, 'SBOM attestation is missing');
  assert.ok(provenance, 'provenance attestation is missing');
  const names = new Set(); collectNames(sbom.predicate, names);
  const requiredVersions = new Map([
    ['node', '24.18.1'], ['musl', '1.2.5-r23'], ['libgcc', '15.2.0-r2'],
    ['libstdc++', '15.2.0-r2'], ['pg', '8.23.0'],
  ]);
  const packages = new Map((sbom.predicate.packages ?? []).map((entry) => [entry.name, entry.versionInfo]));
  for (const [required, version] of requiredVersions) {
    assert.equal(packages.get(required), version,
      `runtime ${required}@${version} component is missing from SBOM`);
  }
  for (const forbidden of ['jest', 'typescript', 'ts-jest']) {
    assert.equal(names.has(forbidden), false, `${forbidden} must not appear in runtime SBOM`);
  }
  assert.ok(attestationSubjects.includes(subject.digest),
    'attestation manifest does not reference runtime image digest');
  if (sbomOutput) writeFileSync(sbomOutput, JSON.stringify(sbom.predicate));
  if (metadataOutput) writeFileSync(metadataOutput, JSON.stringify({
    subjectDigest: subject.digest, configDigest: subjectManifest.config?.digest,
  }));
  process.stdout.write(`OCI artifact PASS ${subject.digest}\n`);

  function json(path) { return JSON.parse(readFileSync(join(directory, path), 'utf8')); }
  function blob(digest) { return json(join('blobs', 'sha256', digest.replace('sha256:', ''))); }
  function flatten(entries) {
    return entries.flatMap((entry) => entry.mediaType === 'application/vnd.oci.image.index.v1+json'
      ? flatten(blob(entry.digest).manifests ?? []) : [entry]);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function collectNames(value, target) {
  if (Array.isArray(value)) return value.forEach((entry) => collectNames(entry, target));
  if (value === null || typeof value !== 'object') return;
  if (typeof value.name === 'string') target.add(value.name);
  Object.values(value).forEach((entry) => collectNames(entry, target));
}
