import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(desktopDir, '..');
const expectedPngMagic = Buffer.from('89504e470d0a1a0a', 'hex');

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

test('ForgeLink branding uses one normalized real PNG everywhere ChatGPT may render it', () => {
  const canonical = path.join(root, 'logo.png');
  const copies = [
    path.join(root, 'web', 'assets', 'branding-logo.png'),
    path.join(root, 'setup-web', 'branding-logo.png'),
    path.join(root, 'desktop', 'renderer', 'public', 'logo.png'),
  ];

  const source = fs.readFileSync(canonical);
  assert.deepEqual(source.subarray(0, 8), expectedPngMagic, 'logo.png must contain actual PNG bytes');
  assert.ok(source.length <= 5 * 1024 * 1024, 'ChatGPT branding asset must stay under 5 MiB');

  const canonicalHash = sha256(canonical);
  for (const copy of copies) {
    assert.equal(sha256(copy), canonicalHash, copy + ' must match canonical ForgeLink logo bytes');
  }
});

test('ChatGPT server and package icon stays small enough for MCP metadata', () => {
  const iconPath = path.join(root, 'chatgpt-logo.png');
  const icon = fs.readFileSync(iconPath);
  assert.deepEqual(icon.subarray(0, 8), expectedPngMagic, 'ChatGPT icon must contain real PNG bytes');
  assert.equal(icon.readUInt32BE(16), 128, 'ChatGPT icon width must be 128 pixels');
  assert.equal(icon.readUInt32BE(20), 128, 'ChatGPT icon height must be 128 pixels');
  assert.ok(icon.length <= 128 * 1024, 'ChatGPT icon must stay small when embedded in MCP metadata');

  const serverSource = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
  assert.match(serverSource, /const forgeLinkIconSrc = \(\) => FORGELINK_LOGO_DATA_URI;/, 'MCP icon metadata must embed the logo directly');
  assert.doesNotMatch(serverSource, /FORGELINK_LOGO_VERSION/, 'MCP icon metadata must not depend on a tunnel URL or cache-buster');
});

test('native artifact builder and portable ChatGPT plugin builder are permanent project scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['build:artifact-ui'], 'node scripts/build-artifact-ui-native.mjs');
  assert.ok(pkg.scripts['build:chatgpt-plugin'].includes('python scripts/build-chatgpt-plugin.py'));
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'prepare-chatgpt-icon.mjs')));
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'build-artifact-ui-native.mjs')));
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'build-chatgpt-plugin.py')));
});
