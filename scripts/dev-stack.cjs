const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const cwd = path.resolve(__dirname, '..');
const node = process.execPath;

const build = spawnSync(node, [path.join(cwd, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.development.json'], {
  cwd, stdio: 'inherit', windowsHide: true,
});
if (build.error || build.status !== 0) process.exit(build.status ?? 1);

const children = [
  spawn(node, [path.join(cwd, 'dist-development/development/development-launcher.js')], {
    cwd, stdio: 'inherit', env: process.env, windowsHide: true,
  }),
  spawn(node, [path.join(cwd, 'node_modules/vite/bin/vite.js'), 'frontend', '--host', 'localhost', '--port', '5173', '--strictPort', '--configLoader', 'native'], {
    cwd, stdio: 'inherit', env: process.env, windowsHide: true,
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const running = children.filter((child) => child.exitCode === null && child.pid !== undefined);
  for (const child of running) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) child.once('exit', (code) => {
  if (!stopping) stop(code === 0 ? 0 : (code ?? 1));
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(0));
