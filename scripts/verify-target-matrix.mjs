import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { COMPATIBILITY_TARGETS, RELEASE_TARGETS, createBuildTarget } = require('../desktop/build-targets.cjs');
const forgeConfig = require('../forge.config.cjs');
const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
const branding = require('../branding.json');

const failures = [];
const reports = [];
const expectedIcon = { win32: 'ico', darwin: 'icns', linux: 'png' };
const rendererContracts = new Set();
const nodePtyRoot = path.resolve('node_modules', 'node-pty');

function expect(condition, message) {
  if (!condition) failures.push(message);
}

for (const target of COMPATIBILITY_TARGETS) {
  const resolved = createBuildTarget({ platform: target.platform, arch: target.arch, root: process.cwd(), logoSource: branding.logoSource });
  rendererContracts.add(JSON.stringify(resolved.renderer));
  const hasWindowsScript = resolved.extraResource.some((item) => /(?:start-mcp|stop-previous-mcp)\.ps1$/i.test(item));
  const prebuildAvailable = fs.existsSync(path.join(nodePtyRoot, 'prebuilds', resolved.nativePty.key));
  const sourceBuildAvailable = fs.existsSync(path.join(nodePtyRoot, 'binding.gyp'));

  expect(resolved.iconExtension === expectedIcon[target.platform], `${resolved.key}: wrong icon extension`);
  expect(path.basename(resolved.iconPath) === `icon.${expectedIcon[target.platform]}`, `${resolved.key}: wrong icon path`);
  expect(resolved.tunnelSource.includes(path.join('vendor', 'tunnel-client', resolved.key)), `${resolved.key}: tunnel path is not target-specific`);
  expect(path.basename(resolved.tunnelSource) === (target.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client'), `${resolved.key}: wrong tunnel executable name`);
  expect(target.platform === 'win32' ? hasWindowsScript : !hasWindowsScript, `${resolved.key}: Windows-only PowerShell resource policy is wrong`);
  expect(prebuildAvailable || sourceBuildAvailable, `${resolved.key}: node-pty has no prebuild and no native build source`);

  reports.push({
    target: resolved.key,
    runner: target.runner,
    icon: path.basename(resolved.iconPath),
    tunnel: path.relative(process.cwd(), resolved.tunnelSource),
    pty: prebuildAvailable ? 'prebuild-available' : 'native-build-on-target-required',
    windowsPowerShellResources: hasWindowsScript,
    rendererEntry: path.relative(process.cwd(), resolved.renderer.entry),
  });
}

expect(rendererContracts.size === 1, 'Renderer contract differs between targets; UI must remain one shared source.');

const makers = forgeConfig.makers || [];
const makerPlatforms = new Map(makers.map((maker) => [maker.name, maker.platforms || []]));
expect(makerPlatforms.get('@electron-forge/maker-squirrel')?.includes('win32'), 'Squirrel maker must cover win32.');
expect(makerPlatforms.get('@electron-forge/maker-dmg')?.includes('darwin'), 'DMG maker must cover darwin.');
expect(makerPlatforms.get('@electron-forge/maker-zip')?.includes('darwin'), 'ZIP maker must cover darwin.');
expect(makerPlatforms.get('@electron-forge/maker-zip')?.includes('linux'), 'ZIP maker must cover linux.');
expect(Array.isArray(forgeConfig.packagerConfig?.beforeAsar) && forgeConfig.packagerConfig.beforeAsar.length > 0, 'Package privacy beforeAsar guard is missing.');
expect(!forgeConfig.packagerConfig?.ignore, 'Custom packagerConfig.ignore would override the Vite plugin safe .vite-only packaging filter.');

for (const target of RELEASE_TARGETS) {
  const script = packageJson.scripts?.[target.makeScript] || '';
  expect(script.includes('assert-native-target.mjs'), `${target.makeScript} must assert a native packaging host`);
  expect(script.includes(target.platform), `${target.makeScript} must identify target ${target.platform}`);
  expect(script.includes('make-native.mjs'), `${target.makeScript} must use the collision-safe native maker wrapper`);
}
for (const script of ['verify:platforms', 'verify:target-matrix', 'make:win', 'make:mac', 'make:linux']) {
  expect(Boolean(packageJson.scripts?.[script]), `package.json is missing ${script}`);
}

const workflow = fs.readFileSync(path.resolve('.github', 'workflows', 'desktop-build.yml'), 'utf8');
for (const runner of ['windows-latest', 'macos-14', 'ubuntu-latest']) expect(workflow.includes(runner), `desktop-build.yml is missing ${runner}`);
for (const makeScript of ['make:win', 'make:mac', 'make:linux']) expect(workflow.includes(makeScript), `desktop-build.yml is missing ${makeScript}`);

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures, reports }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, host: `${process.platform}-${process.arch}`, rendererParity: 'single-shared-source', reports }, null, 2));
