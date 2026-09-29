import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RecoveryManager } from './recovery-manager.mjs';
import { buildCodeChangeReview } from './code-change-review.mjs';
import { ResourceLockManager } from './resource-lock-manager.mjs';

test('revocation after preview or apply blocks the next transaction boundary while rollback remains available', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-revocation-test-'));
  try {
    const workspace = path.join(temporary, 'workspace');
    await fs.mkdir(workspace);
    const target = path.join(workspace, 'source.js');
    await fs.writeFile(target, 'before');
    let authorized = true;
    const manager = new RecoveryManager({
      dataDir: temporary,
      resolveRead: async (value) => value,
      resolveWrite: async (value) => value,
      authorizeWrite: async () => { if (!authorized) throw new Error('approval revoked'); },
    });
    const transaction = await manager.begin(workspace);
    await manager.preview(transaction.id, [{ kind: 'write', path: target, content: 'after' }]);
    authorized = false;
    await assert.rejects(manager.apply(transaction.id), /approval revoked/);
    assert.equal(await fs.readFile(target, 'utf8'), 'before');
    authorized = true;
    await manager.apply(transaction.id);
    authorized = false;
    await assert.rejects(manager.commit(transaction.id), /approval revoked/);
    assert.equal((await manager.status(transaction.id)).status, 'applied');
    assert.equal((await manager.rollback(transaction.id)).status, 'rolled_back');
    assert.equal(await fs.readFile(target, 'utf8'), 'before');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('external worker integration records an exact durable operation review', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-external-review-'));
  try {
    const workspace = path.join(temporary, 'workspace');
    await fs.mkdir(workspace);
    const changed = path.join(workspace, 'changed.js');
    const unrelated = path.join(workspace, 'unrelated.js');
    await fs.writeFile(changed, 'before\n');
    await fs.writeFile(unrelated, 'unrelated before\n');
    const manager = new RecoveryManager({ dataDir: temporary, resolveRead: async (value) => value, resolveWrite: async (value) => value });
    const before = (await manager.capture([changed])).states;
    await fs.writeFile(changed, 'after\n');
    await fs.writeFile(unrelated, 'unrelated after\n');
    const operation = await manager.recordExternalOperation(workspace, [changed], before);
    const restored = new RecoveryManager({ dataDir: temporary, resolveRead: async (value) => value, resolveWrite: async (value) => value });
    const review = await buildCodeChangeReview(await restored.transaction(operation.id));
    assert.equal(review.fileCount, 1);
    assert.equal(review.addedLines, 1);
    assert.equal(review.removedLines, 1);
    assert.equal(review.files[0].path, 'changed.js');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('checkpoints, transactions, undo, redo, and rollback preserve file states', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-recovery-test-'));
  const workspace = path.join(temporary, 'workspace');
  const dataDir = path.join(temporary, 'data');
  await fs.mkdir(workspace);
  const a = path.join(workspace, 'a.txt');
  const b = path.join(workspace, 'b.txt');
  const c = path.join(workspace, 'c.txt');
  const d = path.join(workspace, 'd.txt');
  const e = path.join(workspace, 'e.txt');
  await fs.writeFile(a, 'one');
  await fs.writeFile(b, 'two');
  const locks = new ResourceLockManager();
  const resolve = async (candidate) => {
    const target = path.resolve(candidate);
    const relative = path.relative(workspace, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Outside workspace');
    return target;
  };
  const manager = new RecoveryManager({
    dataDir, resolveRead: resolve, resolveWrite: resolve,
    assertUnlocked: (target, owner) => locks.assertAvailable(target, owner),
    withLease: async (targets, owner, action) => await locks.withLease(targets, owner, action),
  });
  try {
    const snapshot = await manager.createSnapshot([a, b], workspace);
    assert.equal(snapshot.filesCount, 2);
    const begun = await manager.begin(workspace);
    const preview = await manager.preview(begun.id, [
      { kind: 'replace', path: a, oldText: 'one', newText: 'ONE', expectedOccurrences: 1 },
      { kind: 'move', path: b, to: c },
      { kind: 'write', path: d, content: 'new' },
    ]);
    assert.equal(preview.changes.length, 4);
    assert.equal(preview.editSummary.exact, true);
    assert.equal(preview.editSummary.label, 'Editing +2 -1 across 3 files');
    assert.deepEqual(preview.progress, { kind: 'editing', text: preview.editSummary.label, exact: true });
    assert.equal(await fs.readFile(a, 'utf8'), 'one');
    const applied = await manager.apply(begun.id);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.editSummary.exact, true);
    assert.equal(applied.editSummary.label, preview.editSummary.label);
    assert.deepEqual(applied.progress, { kind: 'editing', text: preview.editSummary.label, exact: true });
    assert.equal((await manager.commit(begun.id)).status, 'committed');
    assert.equal(await fs.readFile(a, 'utf8'), 'ONE');
    await assert.rejects(fs.stat(b), { code: 'ENOENT' });
    assert.equal(await fs.readFile(c, 'utf8'), 'two');
    assert.equal(await fs.readFile(d, 'utf8'), 'new');

    assert.equal((await manager.undo(begun.id)).status, 'undone');
    assert.equal(await fs.readFile(a, 'utf8'), 'one');
    assert.equal(await fs.readFile(b, 'utf8'), 'two');
    await assert.rejects(fs.stat(c), { code: 'ENOENT' });
    await assert.rejects(fs.stat(d), { code: 'ENOENT' });
    assert.equal((await manager.redo(begun.id)).status, 'committed');
    assert.equal(await fs.readFile(c, 'utf8'), 'two');

    const afterRestart = new RecoveryManager({ dataDir, resolveRead: resolve, resolveWrite: resolve });
    assert.equal((await afterRestart.status(begun.id)).status, 'committed');
    assert.equal((await manager.compareSnapshot(snapshot.id)).changes.length, 2);
    await manager.restoreSnapshot(snapshot.id);
    assert.equal(await fs.readFile(a, 'utf8'), 'one');
    assert.equal(await fs.readFile(b, 'utf8'), 'two');

    const rollback = await manager.begin(workspace);
    await manager.preview(rollback.id, [{ kind: 'write', path: e, content: 'temporary' }]);
    await manager.apply(rollback.id);
    assert.equal((await manager.rollback(rollback.id)).status, 'rolled_back');
    await assert.rejects(fs.stat(e), { code: 'ENOENT' });

    const conflict = await manager.begin(workspace);
    await manager.preview(conflict.id, [{ kind: 'write', path: a, content: 'planned' }]);
    await fs.writeFile(a, 'someone else changed it');
    await assert.rejects(manager.apply(conflict.id), /changed since preview/);
    assert.equal(await fs.readFile(a, 'utf8'), 'someone else changed it');
    assert.equal((await manager.rollback(conflict.id)).status, 'rolled_back');
    assert.equal((await manager.deleteSnapshot(snapshot.id)).deleted, true);
  } finally {
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('forgelink-recovery-test-')) throw new Error('Refusing to remove an unexpected test directory');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

test('replace-only applied transactions reconcile concurrent edits without polluting exact review', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-reconcile-test-'));
  try {
    const workspace = path.join(temporary, 'workspace');
    await fs.mkdir(workspace);
    const target = path.join(workspace, 'source.js');
    await fs.writeFile(target, 'const value = "before";\n');
    const manager = new RecoveryManager({
      dataDir: temporary,
      resolveRead: async (value) => value,
      resolveWrite: async (value) => value,
    });
    const transaction = await manager.begin(workspace);
    await manager.preview(transaction.id, [{
      kind: 'replace',
      path: target,
      oldText: 'const value = "before";',
      newText: 'const value = "after";',
      expectedOccurrences: 1,
    }]);
    await manager.apply(transaction.id);
    await fs.appendFile(target, '// concurrent\n');
    await assert.rejects(manager.commit(transaction.id), /changed since preview/i);
    const reconciled = await manager.reconcileApplied(transaction.id);
    assert.equal(reconciled.reconciled, true);
    assert.equal(reconciled.status, 'applied');
    const record = await manager.transaction(transaction.id);
    const review = await buildCodeChangeReview({ ...record, status: 'committed' });
    assert.equal(review.fileCount, 1);
    assert.equal(review.addedLines, 1);
    assert.equal(review.removedLines, 1);
    const changedText = review.files[0].hunks.flatMap((hunk) => hunk.lines)
      .filter((line) => line.type === 'add' || line.type === 'remove')
      .map((line) => line.text).join('\n');
    assert.doesNotMatch(changedText, /concurrent/);
    assert.equal((await manager.commit(transaction.id)).status, 'committed');
    assert.equal(await fs.readFile(target, 'utf8'), 'const value = "after";\n// concurrent\n');

    const unsupported = await manager.begin(workspace);
    await manager.preview(unsupported.id, [{ kind: 'write', path: target, content: 'replacement' }]);
    await manager.apply(unsupported.id);
    await assert.rejects(manager.reconcileApplied(unsupported.id), /replace-only/i);
    await manager.rollback(unsupported.id);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('path leases block overlapping resources and expire', () => {
  const locks = new ResourceLockManager();
  const root = path.resolve('workspace');
  const child = path.join(root, 'src', 'main.ts');
  const held = locks.acquire({ resource: root, owner: 'test', leaseSeconds: 10 });
  assert.throws(() => locks.assertAvailable(child), /locked/);
  assert.throws(() => locks.acquire({ resource: child, owner: 'other' }), /locked/);
  assert.equal(locks.get(held.lockId).owner, 'test');
  locks.locks.get(held.lockId).expiresAtMs = Date.now() - 1;
  locks.sweep();
  assert.equal(locks.list().length, 0);
  assert.doesNotThrow(() => locks.assertAvailable(child));
});
