import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PACKAGE_IGNORE_PATTERNS,
  isPackagePrivatePath,
  findPackagePrivacyViolations,
} = require('./package-privacy.cjs');

test('package privacy policy rejects ForgeLink credentials and local runtime state', () => {
  const blocked = [
    'C:\\repo\\.env',
    'C:\\repo\\.env.local',
    'C:\\repo\\.oauth-tokens.json',
    'C:\\repo\\.oauth-clients.json',
    'C:\\repo\\.chatgpt-permission-requests.json',
    'C:\\repo\\.current-tunnel-url',
    'C:\\repo\\desktop-config.json',
    'C:\\repo\\desktop-secrets.json',
    'C:\\repo\\cloudflare-tunnel-token.dpapi',
    'C:\\repo\\agent-audit.jsonl',
    'C:\\repo\\safety-events.jsonl',
    'C:\\repo\\tunnel-client-data\\profiles\\primary.yaml',
    'C:\\repo\\recovery\\state.json',
    'C:\\repo\\native-agent-runtime\\native-swarms.json',
    'C:\\repo\\project-memory\\0123456789abcdef.json',
    'C:\\repo\\engineering\\engineering-sessions.json',
    'C:\\repo\\presentation-artifacts\\walkthrough.json',
  ];

  for (const candidate of blocked) {
    assert.equal(isPackagePrivatePath(candidate), true, candidate);
    assert.equal(PACKAGE_IGNORE_PATTERNS.some((pattern) => pattern.test(candidate)), true, candidate);
  }
});

test('package privacy policy keeps required application resources', () => {
  const allowed = [
    'C:\\repo\\package.json',
    'C:\\repo\\.vite\\build\\main.cjs',
    'C:\\repo\\web\\index.html',
    'C:\\repo\\dist-backend\\backend-entry.mjs',
    'C:\\repo\\desktop\\artifact-ui-client.bundle.js',
    'C:\\repo\\desktop\\renderer\\dist\\index.html',
    'C:\\repo\\start-mcp.ps1',
    'C:\\repo\\branding.json',
  ];
  for (const candidate of allowed) assert.equal(isPackagePrivatePath(candidate), false, candidate);
});

test('staging verifier detects a leaked private file before ASAR creation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgelink-package-privacy-'));
  try {
    fs.mkdirSync(path.join(root, '.vite', 'build'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, '.vite', 'build', 'main.cjs'), 'module.exports = {};');
    fs.writeFileSync(path.join(root, 'desktop-secrets.json'), '{"secret":"redacted"}');

    assert.deepEqual(findPackagePrivacyViolations(root), ['desktop-secrets.json']);

    fs.rmSync(path.join(root, 'desktop-secrets.json'));
    assert.deepEqual(findPackagePrivacyViolations(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
