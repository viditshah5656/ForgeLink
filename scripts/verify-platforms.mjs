import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

function run(label, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(node, args, { cwd: root, stdio: 'inherit', env: process.env, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

run('Build artifact UI', ['scripts/build-artifact-ui-native.mjs']);
run('Cross-platform unit/parity tests', [
  '--test',
  'desktop/platform-runtime.test.mjs',
  'desktop/access-policy.test.mjs',
  'desktop/unix-system-control.test.mjs',
  'desktop/terminal-manager.test.mjs',
  'desktop/package-privacy.test.mjs',
  'desktop/cross-platform-ui-parity.test.mjs',
]);
run('Validate target matrix', ['scripts/verify-target-matrix.mjs']);
run('Prepare host icons', ['scripts/prepare-icons.mjs']);
run('Build shared backend bundle', ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.backend.config.mjs']);
run('Stage host node-pty', ['scripts/prepare-pty.mjs']);
run('Stage TypeScript runtime', ['scripts/prepare-typescript-lib.mjs']);
run('Build shared renderer', ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.renderer.config.mjs']);

console.log(JSON.stringify({
  ok: true,
  host: `${process.platform}-${process.arch}`,
  validatedTargets: ['win32', 'darwin', 'linux'],
  sharedRenderer: 'desktop/renderer/src/main.js',
  note: 'Foreign native binaries were validated structurally only. Real packages are built on their native CI runners.',
}, null, 2));
