'use strict';

const assert = require('node:assert/strict');
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = join(__dirname, '..');
const distributionRoot = join(repositoryRoot, 'dist');
const entrypoint = join(distributionRoot, 'composition', 'main.js');
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));

assert.equal(existsSync(entrypoint), true, 'compiled production entrypoint is missing');
assert.equal(typeof packageJson.dependencies?.pg, 'string', 'pg must be a production dependency');
require.resolve('pg', { paths: [repositoryRoot] });

const artifactFiles = listFiles(distributionRoot).map((file) => relative(distributionRoot, file).replaceAll('\\', '/'));
assert.equal(artifactFiles.some((file) => file.includes('.test.')), false, 'test files entered the artifact');
assert.equal(artifactFiles.some((file) => file.includes('tls-test-certificate')), false,
  'TLS test certificate fixture entered the artifact');
assert.equal(artifactFiles.some((file) => file === 'security/testing.js' || file.startsWith('security/testing.')), false,
  'security test helper entered the artifact');

const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (name.startsWith('PG') || name.startsWith('AUTH_') || name.startsWith('HTTP_')
    || name.startsWith('HTTPS_') || name.startsWith('TLS_') || name.startsWith('RATE_LIMIT_')
    || name.startsWith('SECURITY_') || name === 'OBSERVABILITY_INSTANCE_ID') {
    delete environment[name];
  }
}
const startup = spawnSync(process.execPath, [entrypoint], {
  cwd: repositoryRoot, env: environment, encoding: 'utf8', timeout: 10_000,
});
assert.equal(startup.status, 1, `entrypoint did not fail closed: ${startup.error?.message ?? startup.stderr}`);
assert.match(startup.stderr, /^Invalid configuration: PGHOST is required\r?\n$/,
  'entrypoint did not report the expected opaque configuration failure');
assert.equal(startup.stdout, '', 'entrypoint emitted unexpected stdout during fail-closed startup');

process.stdout.write(`Artifact smoke PASS (${artifactFiles.length} files)\n`);

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  });
}
