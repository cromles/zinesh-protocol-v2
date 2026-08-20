'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const image = process.argv[2];
assert.ok(image, 'usage: node scripts/verify-container-image.cjs <image>');

const inspect = JSON.parse(run(['image', 'inspect', image]).stdout)[0];
assert.equal(inspect.Os, 'linux');
assert.equal(inspect.Architecture, 'amd64');
assert.equal(inspect.Config.User, '1000:1000', 'runtime user must be numeric and non-root');
assert.deepEqual(inspect.Config.Entrypoint, ['node', 'dist/composition/main.js']);
assert.equal(inspect.Config.WorkingDir, '/app');
assert.deepEqual([...inspect.Config.Env].sort(), [
  'HOME=/nonexistent', 'NODE_ENV=production', 'PATH=/usr/local/bin',
]);

const auditProgram = `
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
assert.equal(process.getuid(),1000); assert.equal(process.getgid(),1000); require('pg');
assert.equal(process.version,'v24.18.1'); assert.equal(process.versions.openssl,'3.5.7');
for(const name of ['jest','typescript','ts-jest']) assert.throws(()=>require.resolve(name));
assert.deepEqual(fs.readdirSync('/app').sort(),['dist','node_modules','package-lock.json','package.json']);
for(const p of ['/bin/sh','/bin/busybox','/sbin/apk','/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/corepack','/usr/local/bin/yarn','/opt/yarn-v1.22.22']) assert.equal(fs.existsSync(p),false,p+' must not exist');
for(const p of ['/lib/ld-musl-x86_64.so.1','/usr/lib/libgcc_s.so.1','/usr/lib/libstdc++.so.6','/lib/apk/db/installed','/etc/alpine-release']) assert.equal(fs.existsSync(p),true,p+' must exist');
const installed=fs.readFileSync('/lib/apk/db/installed','utf8');
const packages=[...installed.matchAll(/^P:(.+)$/gm)].map((m)=>m[1]).sort();
assert.deepEqual(packages,['libgcc','libstdc++','musl']);
const files=[]; function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const c=path.join(p,e.name);e.isDirectory()?walk(c):files.push(c)}} walk('/app');
const forbiddenNames=/(^|\\/)(\\.env(?:\\.|$)|\\.git(?:\\/|$)|coverage(?:\\/|$)|src(?:\\/|$)|npm-cache(?:\\/|$))|\\.(pem|key|pfx|p12|crt|cer|der)$|\\.test\\.|tls-test-certificate|security\\/testing/;
assert.equal(files.some(f=>forbiddenNames.test(f.replaceAll('\\\\','/'))),false,'forbidden artifact path found');
for(const f of files){const b=fs.readFileSync(f); if(b.length<5_000_000){const s=b.toString('utf8');assert.equal(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(s),false,'private key material found')}}
process.stdout.write('Container filesystem audit PASS\\n');`;

const hardened = [
  'run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
  '--entrypoint', 'node', image, '-e', auditProgram,
];
run(hardened);

const startup = spawnSync('docker', [
  'run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', image,
], { encoding: 'utf8' });
assert.equal(startup.status, 1, `missing-config startup must fail closed: ${startup.stderr}`);
assert.match(startup.stderr, /^Invalid configuration: PGHOST is required\r?\n$/);
assert.equal(startup.stdout, '');

const history = run(['history', '--no-trunc', '--format', '{{.CreatedBy}}', image]).stdout;
assert.equal(/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|PGPASSWORD=|TLS_PRIVATE_KEY=/.test(history), false,
  'sensitive material appears in image history');

process.stdout.write('Container image audit PASS\n');

function run(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `docker ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}
