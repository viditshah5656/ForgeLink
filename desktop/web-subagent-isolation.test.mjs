import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { prepareSubagentWorkspace } from './web-subagent-isolation.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-subagent-isolation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const dataDir = path.join(root, 'private');
  await fs.mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'node_modules', 'package'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'src', 'app.js'), 'const value = 1;\n');
  await fs.writeFile(path.join(sourceRoot, 'src', 'untracked.js'), 'export const newFile = true;\n');
  await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=never-copy\n');
  await fs.writeFile(path.join(sourceRoot, 'node_modules', 'package', 'index.js'), 'secret dependency\n');
  return { sourceRoot, dataDir };
}

test('private snapshot includes uncommitted files but excludes secrets and generated directories', async (t) => {
  const { sourceRoot, dataDir } = await fixture(t);
  const workspace = await prepareSubagentWorkspace({ sourceRoot, dataDir, id: 'snapshot', mode: 'write', allowedPaths: ['.'] });
  t.after(() => workspace.dispose());
  assert.equal(await fs.readFile(path.join(workspace.root, 'src', 'app.js'), 'utf8'), 'const value = 1;\n');
  assert.equal(await fs.readFile(path.join(workspace.root, 'src', 'untracked.js'), 'utf8'), 'export const newFile = true;\n');
  await assert.rejects(fs.stat(path.join(workspace.root, '.env')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(workspace.root, 'node_modules')), { code: 'ENOENT' });
  await fs.writeFile(path.join(workspace.root, 'src', 'app.js'), 'const value = 2;\n');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'app.js'), 'utf8'), 'const value = 1;\n');
  const review = await workspace.diff();
  assert.deepEqual(review.files.map((file) => [file.path, file.status]), [['src/app.js', 'modified']]);
  assert.match(review.patch, /value = 2/);
});

test('explicit apply enforces scope, review and baseline SHA', async (t) => {
  const { sourceRoot, dataDir } = await fixture(t);
  const workspace = await prepareSubagentWorkspace({ sourceRoot, dataDir, id: 'apply', mode: 'write', allowedPaths: ['src'] });
  t.after(() => workspace.dispose());
  await fs.writeFile(path.join(workspace.root, 'src', 'app.js'), 'const value = 2;\n');
  await fs.writeFile(path.join(workspace.root, 'src', 'added.js'), 'export const added = true;\n');
  await fs.rm(path.join(workspace.root, 'src', 'untracked.js'));
  const review = await workspace.diff();
  assert.deepEqual(review.files.map((file) => [file.path, file.status]), [
    ['src/added.js', 'added'], ['src/app.js', 'modified'], ['src/untracked.js', 'deleted'],
  ]);
  await assert.rejects(workspace.apply({ paths: ['.env'], verifySourceAccess: () => true }), /not an allowed reviewed change/);
  await fs.writeFile(path.join(sourceRoot, 'src', 'app.js'), 'source changed\n');
  await assert.rejects(workspace.apply({ paths: ['src/app.js'], verifySourceAccess: () => true }), /Source changed since subagent snapshot/);
  const result = await workspace.apply({ paths: ['src/added.js', 'src/untracked.js'], verifySourceAccess: (file) => file.startsWith(sourceRoot) && path.isAbsolute(file) });
  assert.deepEqual(result.applied, ['src/added.js', 'src/untracked.js']);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'added.js'), 'utf8'), 'export const added = true;\n');
  await assert.rejects(fs.stat(path.join(sourceRoot, 'src', 'untracked.js')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'app.js'), 'utf8'), 'source changed\n');
});

test('read mode cannot apply and traversal paths are rejected', async (t) => {
  const { sourceRoot, dataDir } = await fixture(t);
  await assert.rejects(prepareSubagentWorkspace({ sourceRoot, dataDir, id: 'bad', allowedPaths: ['../outside'] }), /Unsafe relative path/);
  await assert.rejects(prepareSubagentWorkspace({ sourceRoot, dataDir, id: 'bad', allowedPaths: ['.env'] }), /excluded secret/);
  const workspace = await prepareSubagentWorkspace({ sourceRoot, dataDir, id: 'read', allowedPaths: ['src/app.js'], mode: 'read' });
  const root = workspace.root;
  await assert.rejects(workspace.apply({ paths: ['src/app.js'] }), /Read-only/);
  await workspace.dispose();
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  await workspace.dispose();
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'app.js'), 'utf8'), 'const value = 1;\n');
});

test('Git ignored files stay out of snapshots and size caps stop oversized snapshots', async (t) => {
  const { sourceRoot, dataDir } = await fixture(t);
  await execFileAsync('git', ['init', '--quiet'], { cwd: sourceRoot });
  await fs.writeFile(path.join(sourceRoot, '.gitignore'), '/ignored-local.txt\n');
  await fs.writeFile(path.join(sourceRoot, 'ignored-local.txt'), 'do not send to agent\n');
  const workspace = await prepareSubagentWorkspace({ sourceRoot, dataDir, id: 'ignore', allowedPaths: ['.'], mode: 'read' });
  t.after(() => workspace.dispose());
  await assert.rejects(fs.stat(path.join(workspace.root, 'ignored-local.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(workspace.root, 'src', 'untracked.js'), 'utf8'), 'export const newFile = true;\n');
  await fs.writeFile(path.join(workspace.root, 'ignored-local.txt'), 'agent created ignored file\n');
  assert.equal((await workspace.diff()).files.some((file) => file.path === 'ignored-local.txt'), false);
  await assert.rejects(prepareSubagentWorkspace({ sourceRoot, dataDir, id: 'tiny', allowedPaths: ['src'], maxBytes: 2 }), /size limit exceeded/);
});

test('apply preflights all access checks and rolls back on a later write failure', async (t) => {
  const { sourceRoot, dataDir } = await fixture(t);
  const workspace = await prepareSubagentWorkspace({ sourceRoot, dataDir, id: 'rollback', allowedPaths: ['src'], mode: 'write' });
  t.after(() => workspace.dispose());
  await fs.writeFile(path.join(workspace.root, 'src', 'app.js'), 'const value = 7;\n');
  await fs.writeFile(path.join(workspace.root, 'src', 'untracked.js'), 'export const newFile = false;\n');
  await assert.rejects(workspace.apply({
    paths: ['src/app.js', 'src/untracked.js'],
    verifySourceAccess: (absolute) => !absolute.endsWith('untracked.js'),
  }), /Source write denied/);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'app.js'), 'utf8'), 'const value = 1;\n');
  await assert.rejects(workspace.apply({
    paths: ['src/app.js', 'src/untracked.js'],
    verifySourceAccess: () => true,
    onBeforeWrite: (_relative, index) => { if (index === 1) throw new Error('injected I/O failure'); },
  }), (error) => {
    assert.deepEqual(error.appliedPaths, ['src/app.js']);
    assert.deepEqual(error.rolledBackPaths, ['src/app.js']);
    assert.deepEqual(error.rollbackErrors, []);
    return true;
  });
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'app.js'), 'utf8'), 'const value = 1;\n');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'untracked.js'), 'utf8'), 'export const newFile = true;\n');
});
