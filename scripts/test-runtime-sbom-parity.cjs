'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const [archive, sbomPath, inventoryPath] = process.argv.slice(2);
assert.ok(archive && sbomPath && inventoryPath, 'usage: node scripts/test-runtime-sbom-parity.cjs <archive> <sbom> <inventory>');
const directory = mkdtempSync(join(tmpdir(), 'zinesh-sbom-negative-'));
try {
  const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  assert.ok(inventory.npm.length > 1, 'negative parity tests require multiple production npm packages');
  const target = inventory.npm.find((entry) => !entry.startsWith('pg@')) ?? inventory.npm[0];
  const [targetName, targetVersion] = splitIdentity(target);
  const missingSbom = structuredClone(sbom);
  missingSbom.packages = missingSbom.packages.filter((entry) => !(entry.name === targetName && entry.versionInfo === targetVersion));
  expectFailure('filesystem package missing from SBOM', { sbom: missingSbom });
  const mismatchedSbom = structuredClone(sbom);
  const mismatch = mismatchedSbom.packages.find((entry) => entry.name === targetName && entry.versionInfo === targetVersion);
  assert.ok(mismatch, `cannot find ${target} in real SBOM`);
  mismatch.versionInfo = `${targetVersion}-mismatch`;
  expectFailure('exact version mismatch', { sbom: mismatchedSbom });
  const missingFilesystem = structuredClone(inventory);
  missingFilesystem.npm = missingFilesystem.npm.filter((entry) => entry !== target);
  expectFailure('SBOM package missing from filesystem inventory', { inventory: missingFilesystem });
  process.stdout.write(`Runtime SBOM fail-closed negative tests PASS (${target})\n`);
  function expectFailure(label, mutation) {
    const args = [join(__dirname, 'verify-oci-artifact.cjs'), archive];
    if (mutation.sbom) {
      const path = join(directory, `${label.replaceAll(' ', '-')}.sbom.json`);
      writeFileSync(path, JSON.stringify(mutation.sbom)); args.push(`--sbom-input=${path}`);
    }
    if (mutation.inventory) {
      const path = join(directory, `${label.replaceAll(' ', '-')}.inventory.json`);
      writeFileSync(path, JSON.stringify(mutation.inventory)); args.push(`--inventory-input=${path}`);
    }
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8', env: { ...process.env, ZINESH_SBOM_PARITY_NEGATIVE_TEST: 'true' },
    });
    assert.notEqual(result.status, 0, `${label} was incorrectly accepted`);
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
function splitIdentity(value) {
  const separator = value.lastIndexOf('@');
  assert.ok(separator > 0, `invalid exact package identity: ${value}`);
  return [value.slice(0, separator), value.slice(separator + 1)];
}
