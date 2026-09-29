import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { COMPATIBILITY_TARGETS, createBuildTarget } = require('./build-targets.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(directory, relative = '') {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dist') continue;
    const rel = path.join(relative, entry.name);
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(full, rel));
    else output.push(rel);
  }
  return output;
}

test('all supported targets resolve the exact same renderer contract', () => {
  const contracts = COMPATIBILITY_TARGETS.map(({ platform, arch }) => {
    const target = createBuildTarget({ platform, arch, root, logoSource: 'logo.png' });
    return {
      root: path.relative(root, target.renderer.root),
      html: path.relative(root, target.renderer.html),
      entry: path.relative(root, target.renderer.entry),
      style: path.relative(root, target.renderer.style),
      viteConfig: path.relative(root, target.renderer.viteConfig),
    };
  });
  for (const contract of contracts.slice(1)) assert.deepEqual(contract, contracts[0]);
  assert.equal(contracts[0].entry.replaceAll('\\', '/'), 'desktop/renderer/src/main.js');
  assert.equal(contracts[0].style.replaceAll('\\', '/'), 'desktop/renderer/src/style.css');
});

test('renderer source tree has no platform-specific duplicate entrypoints', () => {
  const renderer = path.join(root, 'desktop', 'renderer');
  const files = walk(renderer).map((file) => file.replaceAll('\\', '/'));
  const forbidden = files.filter((file) =>
    /(^|\/)(windows|win32|macos|darwin|linux)(\/|$)/i.test(file) ||
    /\.(windows|win32|macos|darwin|linux)\.[^.]+$/i.test(file),
  );
  assert.deepEqual(forbidden, []);
  assert.ok(files.includes('src/main.js'));
  assert.ok(files.includes('src/style.css'));
  assert.ok(files.includes('index.html'));
});

test('Electron Forge has one renderer definition shared by all targets', () => {
  const config = require('../forge.config.cjs');
  const vitePlugin = config.plugins.find((plugin) => plugin?.name === '@electron-forge/plugin-vite');
  assert.ok(vitePlugin);
  assert.equal(vitePlugin.config.renderer.length, 1);
  assert.equal(vitePlugin.config.renderer[0].config, 'vite.renderer.config.mjs');
});
