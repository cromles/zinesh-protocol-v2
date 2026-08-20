'use strict';

const assert = require('node:assert/strict');
const { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { basename, dirname, join, posix, relative, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const archive = process.argv[2];
const digestOnly = process.argv.includes('--digest-only');
const argument = (name) => process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
const sbomOutput = argument('--sbom-output');
const metadataOutput = argument('--metadata-output');
const inventoryOutput = argument('--inventory-output');
const sbomInput = argument('--sbom-input');
const inventoryInput = argument('--inventory-input');
if (sbomInput || inventoryInput) {
  assert.equal(process.env.ZINESH_SBOM_PARITY_NEGATIVE_TEST, 'true',
    'inventory overrides are restricted to controlled fail-closed negative tests');
}
assert.ok(archive, 'usage: node scripts/verify-oci-artifact.cjs <archive> [--digest-only] [--sbom-output=<path>] [--metadata-output=<path>] [--inventory-output=<path>] [--sbom-input=<path>] [--inventory-input=<path>]');
const directory = mkdtempSync(join(tmpdir(), 'zinesh-oci-'));

try {
  const extract = spawnSync('tar', ['-xf', archive, '-C', directory], { encoding: 'utf8' });
  assert.equal(extract.status, 0, `cannot extract OCI archive: ${extract.stderr}`);
  const index = json('index.json');
  const descriptors = flatten(index.manifests);
  const subject = descriptors.find((entry) => entry.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest'
    && entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64');
  assert.ok(subject?.digest?.startsWith('sha256:'), 'linux/amd64 subject manifest is missing');
  const subjectManifest = blob(subject.digest);
  if (digestOnly) {
    process.stdout.write(`${subject.digest}\n`);
    process.exit(0);
  }

  const statements = [];
  const attestationSubjects = [];
  for (const descriptor of descriptors.filter((entry) => entry.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest')) {
    const manifest = blob(descriptor.digest);
    if (manifest.subject?.digest !== undefined) attestationSubjects.push(manifest.subject.digest);
    for (const layer of manifest.layers ?? []) statements.push(blob(layer.digest));
  }
  const attachedSbom = statements.find((entry) => String(entry.predicateType).toLowerCase().includes('spdx'));
  const provenance = statements.find((entry) => String(entry.predicateType).toLowerCase().includes('slsa'));
  assert.ok(attachedSbom, 'SBOM attestation is missing');
  assert.ok(provenance, 'provenance attestation is missing');
  assert.ok(attestationSubjects.includes(subject.digest), 'attestation manifest does not reference runtime image digest');

  const rootfs = join(directory, 'rootfs');
  materializeRootfs(subjectManifest.layers ?? [], rootfs);
  const actualInventory = createFilesystemInventory(rootfs);
  const inventory = inventoryInput ? JSON.parse(readFileSync(inventoryInput, 'utf8')) : actualInventory;
  validateInventory(inventory);
  const sbomPredicate = sbomInput ? JSON.parse(readFileSync(sbomInput, 'utf8')) : attachedSbom.predicate;
  const sbomInventory = createSbomInventory(sbomPredicate);
  compareExact('npm', inventory.npm, sbomInventory.npm);
  compareExact('native APK', inventory.apk, sbomInventory.apk);
  assert.ok(inventory.node.files.includes('/usr/local/bin/node'), 'Node binary is missing from filesystem inventory');
  compareExact('Node runtime', [`node@${inventory.node.version}`], sbomInventory.node);
  for (const forbidden of ['jest', 'typescript', 'ts-jest']) {
    assert.equal([...sbomInventory.npm].some((identity) => identity.startsWith(`${forbidden}@`)), false,
      `${forbidden} must not appear in runtime SBOM`);
  }
  if (sbomOutput) writeFileSync(sbomOutput, JSON.stringify(attachedSbom.predicate));
  if (inventoryOutput) writeFileSync(inventoryOutput, JSON.stringify(actualInventory, null, 2));
  if (metadataOutput) writeFileSync(metadataOutput, JSON.stringify({ subjectDigest: subject.digest, configDigest: subjectManifest.config?.digest }));
  process.stdout.write(`OCI artifact and complete runtime SBOM parity PASS ${subject.digest}\n`);

  function json(path) { return JSON.parse(readFileSync(join(directory, path), 'utf8')); }
  function blob(digest) { return json(join('blobs', 'sha256', digest.replace('sha256:', ''))); }
  function flatten(entries) {
    return entries.flatMap((entry) => entry.mediaType === 'application/vnd.oci.image.index.v1+json'
      ? flatten(blob(entry.digest).manifests ?? []) : [entry]);
  }
  function materializeRootfs(layers, target) {
    mkdirSync(target);
    for (const [index, layer] of layers.entries()) {
      const layerArchive = join(directory, 'blobs', 'sha256', layer.digest.replace('sha256:', ''));
      const listing = spawnSync('tar', ['-tf', layerArchive], { encoding: 'utf8' });
      assert.equal(listing.status, 0, `cannot list OCI layer ${layer.digest}: ${listing.stderr}`);
      for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
        const normalized = posix.normalize(entry.replace(/^\.\//, ''));
        assert.equal(posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../'), false,
          `unsafe path in OCI layer ${index}: ${entry}`);
      }
      const layerDirectory = join(directory, `layer-${index}`);
      mkdirSync(layerDirectory);
      const unpack = spawnSync('tar', ['-xf', layerArchive, '-C', layerDirectory], { encoding: 'utf8' });
      assert.equal(unpack.status, 0, `cannot extract OCI layer ${layer.digest}: ${unpack.stderr}`);
      applyLayer(layerDirectory, target);
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function applyLayer(source, target) {
  const entries = walk(source);
  for (const path of entries.filter((entry) => basename(entry) === '.wh..wh..opq')) {
    const destination = join(target, relative(source, dirname(path)));
    if (existsSync(destination)) for (const child of readdirSync(destination)) rmSync(join(destination, child), { recursive: true, force: true });
  }
  for (const path of entries.filter((entry) => basename(entry).startsWith('.wh.') && basename(entry) !== '.wh..wh..opq')) {
    rmSync(join(target, relative(source, dirname(path)), basename(path).slice(4)), { recursive: true, force: true });
  }
  for (const path of entries.filter((entry) => !basename(entry).startsWith('.wh.'))) {
    const destination = join(target, relative(source, path));
    if (lstatSync(path).isDirectory()) mkdirSync(destination, { recursive: true });
    else {
      mkdirSync(dirname(destination), { recursive: true });
      rmSync(destination, { recursive: true, force: true });
      cpSync(path, destination, { dereference: false });
    }
  }
}

function walk(root) {
  if (!existsSync(root)) return [];
  const output = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    output.push(path);
    if (entry.isDirectory()) output.push(...walk(path));
  }
  return output;
}

function createFilesystemInventory(rootfs) {
  const npm = new Set();
  scanNodeModules(join(rootfs, 'app', 'node_modules'), npm);
  const applicationManifest = JSON.parse(readFileSync(join(rootfs, 'app', 'package.json'), 'utf8'));
  npm.add(identity(applicationManifest.name, applicationManifest.version));
  assert.ok(npm.size > 0, 'production node_modules filesystem inventory is empty');
  const apkDatabase = join(rootfs, 'lib', 'apk', 'db', 'installed');
  assert.ok(existsSync(apkDatabase), 'native APK inventory cannot be created: installed database is missing');
  const apkRecords = parseApkDatabase(readFileSync(apkDatabase, 'utf8'));
  assert.ok(apkRecords.length > 0, 'native APK inventory is empty');
  const nativeFiles = walk(rootfs).filter((path) => lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    .map((path) => `/${relative(rootfs, path).split(sep).join('/')}`)
    .filter((path) => path === '/usr/local/bin/node' || /^\/(?:lib|usr\/lib)\/(?:ld-musl-|lib[^/]+\.so(?:\.|$))/.test(path));
  assert.ok(nativeFiles.length > 1, 'native filesystem inventory is empty');
  const packageFiles = new Map(apkRecords.map((record) => [record.identity, new Set(record.files)]));
  for (const path of nativeFiles.filter((entry) => entry !== '/usr/local/bin/node')) {
    const owners = [...packageFiles].filter(([, files]) => files.has(path)).map(([identity]) => identity);
    assert.equal(owners.length, 1, `native file ${path} must map to exactly one APK package, found: ${owners.join(', ') || 'none'}`);
  }
  for (const [packageIdentity, files] of packageFiles) {
    assert.ok(nativeFiles.some((path) => files.has(path)), `${packageIdentity} has no corresponding native runtime file`);
  }
  return { npm: [...npm].sort(), apk: apkRecords.map((entry) => entry.identity).sort(), nativeFiles: nativeFiles.sort(), node: { version: '24.18.1', files: ['/usr/local/bin/node'] } };
}

function scanNodeModules(directory, target) {
  assert.ok(existsSync(directory), `node_modules directory is missing: ${directory}`);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (scoped.isDirectory() || scoped.isSymbolicLink()) addNpmPackage(join(path, scoped.name), target);
      }
    } else addNpmPackage(path, target);
  }
}

function addNpmPackage(directory, target) {
  const manifestPath = join(directory, 'package.json');
  assert.ok(existsSync(manifestPath), `runtime npm package has no package.json: ${directory}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(typeof manifest.name, 'string', `runtime npm package has no name: ${directory}`);
  assert.equal(typeof manifest.version, 'string', `runtime npm package has no version: ${directory}`);
  target.add(identity(manifest.name, manifest.version));
  const nested = join(directory, 'node_modules');
  if (existsSync(nested)) scanNodeModules(nested, target);
}

function parseApkDatabase(content) {
  return content.trim().split(/\n\s*\n/).map((block) => {
    let name; let version; let currentDirectory = '';
    const files = [];
    for (const line of block.split(/\r?\n/)) {
      const marker = line.slice(0, 2); const value = line.slice(2);
      if (marker === 'P:') name = value;
      else if (marker === 'V:') version = value;
      else if (marker === 'F:') currentDirectory = value;
      else if (marker === 'R:') files.push(`/${posix.join(currentDirectory, value)}`);
    }
    assert.ok(name && version, 'APK record has no exact package identity');
    assert.ok(files.length > 0, `${name}@${version} APK record has no file ownership data`);
    return { identity: identity(name, version), files };
  });
}

function createSbomInventory(sbom) {
  assert.ok(Array.isArray(sbom?.packages), 'SBOM packages cannot be parsed');
  const inventory = { npm: new Set(), apk: new Set(), node: new Set() };
  for (const entry of sbom.packages) {
    assert.equal(typeof entry.name, 'string', 'SBOM package has no name');
    const types = new Set((entry.externalRefs ?? []).filter((reference) => String(reference.referenceType).toLowerCase().includes('purl'))
      .map((reference) => purlType(reference.referenceLocator)).filter(Boolean));
    const runtimeComponent = types.has('npm') || types.has('apk') || entry.name === 'node';
    if (runtimeComponent) assert.equal(typeof entry.versionInfo, 'string', `runtime SBOM package ${entry.name} has no exact version`);
    if (types.has('npm')) inventory.npm.add(identity(entry.name, entry.versionInfo));
    if (types.has('apk')) inventory.apk.add(identity(entry.name, entry.versionInfo));
    if (entry.name === 'node') {
      assert.equal(types.has('generic'), true, 'Node SBOM component has no generic package identity');
      assert.match(entry.sourceInfo ?? '', /(?:^|\s)\/usr\/local\/bin\/node(?:\s|$)/,
        'Node SBOM component is not linked to the runtime binary path');
      inventory.node.add(identity(entry.name, entry.versionInfo));
    }
  }
  assert.ok(inventory.npm.size > 0, 'SBOM contains no npm runtime inventory');
  assert.ok(inventory.apk.size > 0, 'SBOM contains no APK runtime inventory');
  return inventory;
}

function purlType(locator) { return /^pkg:([^/]+)\//.exec(String(locator))?.[1]?.toLowerCase(); }
function identity(name, version) { assert.ok(name && version, 'package identity requires exact name and version'); return `${name}@${version}`; }
function validateInventory(inventory) {
  for (const field of ['npm', 'apk', 'nativeFiles']) {
    assert.ok(Array.isArray(inventory?.[field]) && inventory[field].length > 0, `filesystem inventory ${field} cannot be parsed or is empty`);
    assert.equal(new Set(inventory[field]).size, inventory[field].length, `filesystem inventory ${field} contains duplicates`);
  }
  assert.equal(typeof inventory?.node?.version, 'string', 'filesystem Node inventory has no exact version');
  assert.ok(Array.isArray(inventory.node.files) && inventory.node.files.length > 0, 'filesystem Node inventory has no files');
}
function compareExact(label, filesystemEntries, sbomEntries) {
  const filesystem = new Set(filesystemEntries);
  const missingFromSbom = [...filesystem].filter((entry) => !sbomEntries.has(entry));
  const missingFromFilesystem = [...sbomEntries].filter((entry) => !filesystem.has(entry));
  assert.deepEqual(missingFromSbom, [], `${label} filesystem packages missing from SBOM: ${missingFromSbom.join(', ')}`);
  assert.deepEqual(missingFromFilesystem, [], `${label} SBOM packages missing from filesystem: ${missingFromFilesystem.join(', ')}`);
}
