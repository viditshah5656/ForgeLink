import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidTunnelId, maskTunnelId, normalizeTerminalMode, redactSensitive } from './shared.mjs';

const tunnelId = `tunnel_${'0'.repeat(32)}`;

test('validates exact OpenAI tunnel identifiers', () => {
  assert.equal(isValidTunnelId(tunnelId), true);
  assert.equal(isValidTunnelId('tunnel_TOO_SHORT'), false);
  assert.equal(isValidTunnelId(`tunnel_${'A'.repeat(32)}`), false);
});

test('normalizes permission modes to the safest default', () => {
  assert.equal(normalizeTerminalMode('safe'), 'safe');
  assert.equal(normalizeTerminalMode('anything'), 'off');
});

test('masks identifiers and redacts credentials from errors', () => {
  assert.equal(maskTunnelId(tunnelId), `tunnel_${'0'.repeat(5)}…${'0'.repeat(4)}`);
  const fakeKey = ['sk', 'x'.repeat(24)].join('-');
  const clean = redactSensitive(`bad ${fakeKey} and ${tunnelId}`);
  assert.equal(clean.includes('x'.repeat(24)), false);
  assert.equal(clean.includes('0'.repeat(16)), false);
});
