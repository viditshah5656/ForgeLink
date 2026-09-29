import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectPathEnvironment, environmentDiff, environmentSnapshot, inspectShellProfile, parseLog, correlateLogEntries, explainDiagnosticError, parseUnifiedDiff, generatedFileHint } from './agent-diagnostics.mjs';

test('PATH inventory preserves precedence and finds conflicts without executing binaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-path-test-'));
  try {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await fs.mkdir(first); await fs.mkdir(second);
    await fs.writeFile(path.join(first, 'sample'), 'one');
    await fs.writeFile(path.join(second, 'sample'), 'two');
    const result = await inspectPathEnvironment({ pathValue: `${first}:${second}`, platform: 'linux', names: { sample: ['sample'] } });
    assert.equal(result.tools.sample.selected, path.join(first, 'sample'));
    assert.equal(result.tools.sample.conflict, true);
  } finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('forgelink-path-test-')) throw new Error('Refusing to remove an unexpected test directory');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

test('environment and profile diagnostics expose bounded nonsecret structure', () => {
  const before = environmentSnapshot({ PATH: '/one', NODE_ENV: 'development', PASSWORD: 'hidden' });
  const after = environmentSnapshot({ PATH: '/two', NODE_ENV: 'development' });
  assert.equal(before.values.PASSWORD, undefined);
  assert.deepEqual(environmentDiff(before, after).changes.map((item) => item.name), ['PATH']);
  const profile = inspectShellProfile('alias ll="ls -la"\nfunction Build-App { }\nexport PATH=/tools:$PATH');
  assert.equal(profile.aliases[0].name, 'll');
  assert.equal(profile.functions[0].name, 'Build-App');
  assert.equal(profile.pathChanges.length, 1);
});

test('log parsing redacts secrets, correlates IDs, and classifies errors', () => {
  const entries = parseLog('{"level":"ERROR","message":"api_key=secret123","request_id":"request_12345678"}\nTraceback (most recent call last):');
  assert.equal(entries[0].requestId, 'request_12345678');
  assert.doesNotMatch(entries[0].message, /secret123/);
  assert.equal(entries[1].format, 'python-traceback');
  assert.equal(correlateLogEntries(entries, 'request_12345678').length, 1);
  assert.equal(explainDiagnosticError('EADDRINUSE').errorCode, 'PORT_IN_USE');
  const stack = parseLog('ERROR: failed request_id=request_12345678\n    at run (app.js:2:3)');
  assert.equal(stack.length, 1);
  assert.equal(stack[0].stack.length, 1);
  assert.equal(parseLog('INFO: ready')[0].level, 'INFO');
  assert.equal(parseLog('{"log":"booted","stream":"stdout","time":"2026-01-01"}')[0].format, 'docker-json');
  assert.equal(parseLog('<testsuite><testcase name="case" classname="suite" time="0.1"><failure/></testcase></testsuite>')[0].level, 'ERROR');
});

test('diff and generated-file metadata retain structure without file contents', () => {
  const diff = parseUnifiedDiff('diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n');
  assert.equal(diff.files[0].addedLines, 1);
  assert.equal(diff.files[0].removedLines, 1);
  assert.deepEqual(diff.files[0].hunks[0].lines.map((item) => [item.type, item.oldLine, item.newLine]), [['remove', 1, null], ['add', null, 1]]);
  const hint = generatedFileHint('/project/dist/app.js', '// @generated');
  assert.equal(hint.likelyGenerated, true);
  assert.equal(hint.confidence, 'high');
});
