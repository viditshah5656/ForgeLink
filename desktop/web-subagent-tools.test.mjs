import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSubagentTools, assertDisjointSubagentWrites } from './web-subagent-tools.mjs';

async function fixture(fn) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-subagent-tools-'));
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(outside);
  try { await fn({ root, outside }); }
  finally { await fs.rm(base, { recursive: true, force: true }); }
}
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');

test('read tools expose bounded, scoped Responses function specs', async () => fixture(async ({ root }) => {
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'alpha\nbeta\n');
  await fs.writeFile(path.join(root, 'src', '.env'), 'TOP_SECRET=abc');
  const tools = createSubagentTools({ root, allowedPaths: ['src'], mode: 'read' });
  assert.deepEqual(tools.specs.map((item) => item.name), ['fs_list', 'fs_read', 'fs_search']);
  assert.ok(tools.specs.every((item) => item.type === 'function' && item.strict && item.parameters.additionalProperties === false));
  const listed = await tools.execute('fs_list', { path: 'src', maxEntries: 10 });
  assert.deepEqual(listed.entries.map((entry) => entry.name), ['a.txt']);
  const read = await tools.execute('fs_read', { path: 'src/a.txt', startLine: 1, endLine: 2 });
  assert.equal(read.sha256, digest('alpha\nbeta\n'));
  assert.deepEqual(read.lines.map((line) => line.text), ['alpha', 'beta']);
  const searched = await tools.execute('fs_search', { path: 'src', query: 'beta', maxResults: 10 });
  assert.deepEqual(searched.matches.map((match) => match.path), [path.join('src', 'a.txt')]);
  await assert.rejects(tools.execute('fs_write', { path: 'src/a.txt', content: 'x', expectedSha256: read.sha256 }), /Unknown or unavailable/);
  await assert.rejects(tools.execute('fs_read', { path: '../outside/x', startLine: 1, endLine: 1 }), /outside the subagent root/);
  await assert.rejects(tools.execute('fs_read', { path: '.env', startLine: 1, endLine: 1 }), /Sensitive or excluded/);
  await assert.rejects(tools.execute('fs_read', { path: 'src/a.txt', startLine: 1, endLine: 9999 }), /Read must request/);
}));

test('write scope and content hashes prevent out of scope and stale edits', async () => fixture(async ({ root }) => {
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'alpha\nbeta\n');
  await fs.writeFile(path.join(root, 'README.md'), 'read only');
  const tools = createSubagentTools({ root, allowedPaths: ['.'], writePaths: ['src'], mode: 'write' });
  const oldHash = digest('alpha\nbeta\n');
  await assert.rejects(tools.execute('fs_write', { path: 'README.md', content: 'change', expectedSha256: digest('read only') }), /write scopes/);
  await assert.rejects(tools.execute('fs_write', { path: 'src/a.txt', content: 'change', expectedSha256: null }), /already exists/);
  await assert.rejects(tools.execute('fs_write', { path: 'src/a.txt', content: 'change', expectedSha256: digest('wrong') }), /hash mismatch/i);
  const changed = await tools.execute('fs_replace', { path: 'src/a.txt', oldText: 'beta', newText: 'gamma', expectedSha256: oldHash });
  assert.equal(changed.sha256, digest('alpha\ngamma\n'));
  assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), 'alpha\ngamma\n');
  await assert.rejects(tools.execute('fs_replace', { path: 'src/a.txt', oldText: 'alpha', newText: 'x', expectedSha256: oldHash }), /hash mismatch/i);
  const created = await tools.execute('fs_write', { path: 'src/new.txt', content: 'created', expectedSha256: null });
  assert.equal(created.created, true);
  await tools.execute('fs_delete', { path: 'src/new.txt', expectedSha256: digest('created') });
  await assert.rejects(fs.stat(path.join(root, 'src', 'new.txt')), { code: 'ENOENT' });
}));

test('symlink, binary, oversized, and credential content are refused', async () => fixture(async ({ root, outside }) => {
  await fs.writeFile(path.join(outside, 'data.txt'), 'outside');
  await fs.writeFile(path.join(root, 'src', 'binary.dat'), Buffer.from([1, 0, 2]));
  await fs.writeFile(path.join(root, 'src', 'large.txt'), 'x'.repeat(100));
  await fs.writeFile(path.join(root, 'src', 'credential.txt'), 'API_KEY=abcdefghijklmnopqrstuvwxyz012345');
  const tools = createSubagentTools({ root, allowedPaths: ['.'], writePaths: ['src'], mode: 'write', limits: { maxFileBytes: 64, maxWriteBytes: 64 } });
  await assert.rejects(tools.execute('fs_read', { path: 'src/binary.dat', startLine: 1, endLine: 1 }), /Binary files/);
  await assert.rejects(tools.execute('fs_read', { path: 'src/large.txt', startLine: 1, endLine: 1 }), /regular text files/);
  await assert.rejects(tools.execute('fs_read', { path: 'src/credential.txt', startLine: 1, endLine: 1 }), /Sensitive credential/);
  await assert.rejects(tools.execute('fs_write', { path: 'src/new.txt', content: 'PASSWORD=abcdefghijklmnopq', expectedSha256: null }), /Sensitive credential/);
  try { await fs.symlink(outside, path.join(root, 'src', 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return; throw error; }
  await assert.rejects(tools.execute('fs_read', { path: 'src/link/data.txt', startLine: 1, endLine: 1 }), /Symbolic links and junctions/);
  await assert.rejects(tools.execute('fs_write', { path: 'src/link/new.txt', content: 'oops', expectedSha256: null }), /Symbolic links and junctions/);
  await assert.rejects(fs.stat(path.join(outside, 'new.txt')), { code: 'ENOENT' });
}));

test('parallel workers must have disjoint write scopes and concurrent stale edits fail', async () => fixture(async ({ root }) => {
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'src', 'shared.txt'), 'before');
  const first = createSubagentTools({ root, allowedPaths: ['.'], writePaths: ['src'], mode: 'write' });
  const second = createSubagentTools({ root, allowedPaths: ['.'], writePaths: ['tests'], mode: 'write' });
  assert.equal(assertDisjointSubagentWrites([first, second]), true);
  const colliding = createSubagentTools({ root, allowedPaths: ['.'], writePaths: ['src/shared.txt'], mode: 'write' });
  assert.throws(() => assertDisjointSubagentWrites([first, colliding]), /overlapping write scopes/);
  const results = await Promise.allSettled([
    first.execute('fs_write', { path: 'src/shared.txt', content: 'one', expectedSha256: digest('before') }),
    first.execute('fs_write', { path: 'src/shared.txt', content: 'two', expectedSha256: digest('before') }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
}));
