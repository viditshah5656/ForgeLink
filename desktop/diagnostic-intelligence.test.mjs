import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { describeZodInput, inspectPathSources, inspectProxyConfig, semanticError } from './diagnostic-intelligence.mjs';

test('tool schema descriptions preserve optionality and bounds', () => {
  const input = describeZodInput(z.string().min(2).max(20).optional());
  assert.equal(input.type, 'string');
  assert.equal(input.required, false);
  assert.deepEqual(input.constraints.map((item) => item.kind), ['min', 'max']);
});

test('proxy and error diagnostics redact credentials and keep actionable structure', () => {
  const config = inspectProxyConfig('location /api {\nproxy_pass http://127.0.0.1:3000;\n}', 'nginx.conf');
  assert.equal(config.routes[0].path, '/api');
  assert.equal(config.upstreams[0].target, 'http://127.0.0.1:3000');
  const error = semanticError(new Error('EACCES: api_key=verysecret'), 'read');
  assert.equal(error.error_code, 'PERMISSION_DENIED');
  assert.doesNotMatch(error.message, /verysecret/);
  const stale = semanticError(new Error('Permission request is unavailable, expired, or already resolved.'), 'resolve_chat_permission');
  assert.equal(stale.error_code, 'PERMISSION_REQUEST_STALE');
  assert.match(stale.possible_recovery, /fresh permission request/);
});

test('permission errors point ChatGPT to the exact approval card tool', () => {
  const cases = [
    ['Path is outside a write-approved root', 'request_path_access'],
    ['Full Headless Terminal is disabled', 'request_terminal_access'],
    ['System Control is Off', 'request_system_control_access'],
    ['SECURITY_MAINTENANCE_REQUIRED: protected source', 'request_security_maintenance'],
  ];
  for (const [message, tool] of cases) {
    const result = semanticError(new Error(message), 'example_operation');
    assert.equal(result.permission_request_tool, tool);
    assert.match(result.possible_recovery, /ChatGPT/);
  }
});

test('non-Windows PATH sources do not execute a shell', async () => {
  const result = await inspectPathSources({ platform: 'linux', env: { PATH: '/one:/two' } });
  assert.deepEqual(result.sourcesAvailable, ['process']);
  assert.equal(result.process.length, 2);
});
