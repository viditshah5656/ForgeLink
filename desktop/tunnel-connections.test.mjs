import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTunnelProfile,
  chooseNextHealthPort,
  maskConnection,
  normalizeConfiguration,
  normalizeSecrets,
  sanitizeConfiguration,
  validateConnectionInput,
} from './tunnel-connections.mjs';

const tunnelA = `tunnel_${'a'.repeat(32)}`;
const tunnelB = `tunnel_${'b'.repeat(32)}`;

test('migrates the legacy single tunnel into a primary connection', () => {
  const config = normalizeConfiguration({
    version: 1,
    tunnelId: tunnelA,
    allowedRoots: ['C:\\Coding'],
    terminalMode: 'full',
    systemControlMode: 'read',
    launchAtLogin: true,
  });
  assert.equal(config.version, 2);
  assert.equal(config.connections.length, 1);
  assert.equal(config.connections[0].id, 'primary');
  assert.equal(config.connections[0].tunnelId, tunnelA);
  assert.equal(config.connections[0].healthPort, 24124);
  assert.equal(config.allowedRoots[0], 'C:\\Coding');
  assert.equal(config.systemControlMode, 'read');
});

test('migrates the legacy encrypted key onto the migrated connection', () => {
  const config = normalizeConfiguration({ tunnelId: tunnelA });
  const secrets = normalizeSecrets({ version: 1, apiKey: 'encrypted-old-key' }, config.connections);
  assert.deepEqual(secrets, {
    version: 2,
    connections: { primary: { apiKey: 'encrypted-old-key' } },
  });
});

test('builds independent profiles that share the same MCP origin', () => {
  const profileA = buildTunnelProfile({ tunnelId: tunnelA, healthPort: 24124 });
  const profileB = buildTunnelProfile({ tunnelId: tunnelB, healthPort: 24125 });
  assert.match(profileA, /tunnel_id: "tunnel_/);
  assert.match(profileB, /tunnel_id: "tunnel_/);
  assert.match(profileA, /listen_addr: "127\.0\.0\.1:24124"/);
  assert.match(profileB, /listen_addr: "127\.0\.0\.1:24125"/);
  assert.match(profileA, /url: "http:\/\/127\.0\.0\.1:24024\/mcp"/);
  assert.match(profileB, /url: "http:\/\/127\.0\.0\.1:24024\/mcp"/);
});

test('chooses the next unused local health port', () => {
  const next = chooseNextHealthPort(
    [{ id: 'a', healthPort: 24124 }],
    new Set([24125]),
  );
  assert.equal(next, 24126);
});

test('sanitizes connection state without storing or returning API keys', () => {
  const config = normalizeConfiguration({
    version: 2,
    connections: [{ id: 'a', name: 'Personal', tunnelId: tunnelA, healthPort: 24124 }],
  });
  const safe = sanitizeConfiguration(config, { a: { state: 'running' } });
  assert.equal(safe.connections[0].tunnelId, tunnelA);
  assert.equal(safe.connections[0].tunnelIdMasked, `tunnel_aaaaa…aaaa`);
  assert.equal(safe.connections[0].runtime.state, 'running');
  assert.equal('apiKey' in safe.connections[0], false);
  assert.equal(maskConnection(config.connections[0]).tunnelIdMasked, `tunnel_aaaaa…aaaa`);
});

test('rejects malformed tunnel IDs', () => {
  assert.throws(
    () => validateConnectionInput({ name: 'Other', tunnelId: 'not-a-tunnel', apiKey: 'test-placeholder' }),
    /tunnel ID/i,
  );
});

test('normalizes and sanitizes automationMode and headlessBackground settings', () => {
  const defaultCfg = normalizeConfiguration({});
  assert.equal(defaultCfg.automationMode, 'off');
  assert.equal(defaultCfg.headlessBackground, false);

  const headlessCfg = normalizeConfiguration({
    automationMode: 'headless',
    headlessBackground: true,
  });
  assert.equal(headlessCfg.automationMode, 'headless');
  assert.equal(headlessCfg.headlessBackground, true);

  const sanitized = sanitizeConfiguration(headlessCfg);
  assert.equal(sanitized.automationMode, 'headless');
  assert.equal(sanitized.headlessBackground, true);

  const invalidModeCfg = normalizeConfiguration({
    automationMode: 'invalid_mode',
    headlessBackground: 'not_a_bool',
  });
  assert.equal(invalidModeCfg.automationMode, 'off');
  assert.equal(invalidModeCfg.headlessBackground, false);
});
