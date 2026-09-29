import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildCodeChangeReview, buildTransactionEditSummary, combineWorkflowCodeReviews } from './code-change-review.mjs';

const snapshot = (value) => value === null
  ? { exists: false }
  : { exists: true, data: Buffer.from(value).toString('base64') };

test('code review counts only the transaction snapshots, including added and deleted files', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-review-test-'));
  const names = ['src/changed.js', 'src/new.js', 'src/removed.js'].map((name) => path.join(workspace, name));
  const before = [snapshot('const value = 1;\n'), snapshot(null), snapshot('old line\n')];
  const after = [snapshot('const value = 2;\n'), snapshot('first\nsecond\n'), snapshot(null)];
  try {
    const unrelated = path.join(workspace, 'unrelated.js');
    await fs.writeFile(unrelated, 'dirty but outside the transaction\n');
    const record = {
      id: '5df65cd8-e42d-408f-bd22-bd0e3a24baf4',
      workspace,
      status: 'committed',
      paths: names,
      before: Object.fromEntries(names.map((name, index) => [name, before[index]])),
      after: Object.fromEntries(names.map((name, index) => [name, after[index]])),
    };
    const review = await buildCodeChangeReview(record);
    const previewSummary = await buildTransactionEditSummary({ ...record, status: 'previewed' });
    assert.deepEqual(previewSummary, {
      exact: true,
      fileCount: 3,
      addedLines: 3,
      removedLines: 2,
      label: 'Editing +3 -2 across 3 files',
      source: 'transaction_snapshots',
    });
    await assert.rejects(buildCodeChangeReview({ ...record, status: 'applied' }), /committed or undone/);
    assert.equal(review.fileCount, 3);
    assert.equal(review.addedLines, 3);
    assert.equal(review.removedLines, 2);
    assert.equal(review.undoAvailable, true);
    assert.equal(review.redoAvailable, false);
    assert.equal(review.source, 'transaction_snapshots');
    assert.deepEqual(new Set(review.files.map((file) => file.path)), new Set(['src/changed.js', 'src/new.js', 'src/removed.js']));
    assert.equal(review.files.find((file) => file.path === 'src/new.js')?.addedLines, 2);
    assert.equal(review.files.find((file) => file.path === 'src/removed.js')?.removedLines, 1);
    assert.equal(review.files.find((file) => file.path === 'src/new.js')?.status, 'added');
    assert.equal(review.files.find((file) => file.path === 'src/removed.js')?.status, 'deleted');
    assert.ok(review.files.find((file) => file.path === 'src/changed.js')?.hunks.length);
    assert.ok(review.files.every((file) => !file.path.includes('unrelated')));
    const undoneReview = await buildCodeChangeReview({ ...record, status: 'undone' });
    assert.equal(undoneReview.undoAvailable, false);
    assert.equal(undoneReview.redoAvailable, true);
    assert.equal(undoneReview.addedLines, review.addedLines);
    assert.equal(undoneReview.removedLines, review.removedLines);
  } finally {
    const resolved = path.resolve(workspace);
    if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith('forgelink-review-test-')) {
      await fs.rm(resolved, { recursive: true, force: true });
    }
  }
});

test('workflow review uses one card with unique files and exact totals from every operation', () => {
  const common = { workspace: '/project', status: 'committed', truncated: false };
  const file = (filename, addedLines, removedLines) => ({ path: filename, status: 'modified', addedLines, removedLines, binary: false, hunks: [{ header: '@@', lines: [{ type: 'add', text: 'change' }] }] });
  const first = { ...common, operationId: 'op-1', reviewId: '1111111111111111', addedLines: 3, removedLines: 1, files: [file('src/a.js', 2, 1), file('src/b.js', 1, 0)] };
  const second = { ...common, operationId: 'op-2', reviewId: '2222222222222222', addedLines: 4, removedLines: 2, files: [file('src/a.js', 4, 2)] };
  const combined = combineWorkflowCodeReviews('workflow-1', [first, second]);
  assert.equal(combined.operationCount, 2);
  assert.equal(combined.fileCount, 2);
  assert.equal(combined.addedLines, 7);
  assert.equal(combined.removedLines, 3);
  assert.equal(combined.files.find((entry) => entry.path === 'src/a.js').addedLines, 6);
  assert.deepEqual(combined.files.find((entry) => entry.path === 'src/a.js').hunks.map((hunk) => hunk.header), ['Operation 1: @@', 'Operation 2: @@']);
  assert.deepEqual(combined.operationReviews, [{ operationId: 'op-1', reviewId: first.reviewId }, { operationId: 'op-2', reviewId: second.reviewId }]);
  assert.notEqual(combined.reviewId, combineWorkflowCodeReviews('workflow-1', [first]).reviewId);
  assert.throws(() => combineWorkflowCodeReviews('workflow-1', [first, { ...second, workspace: '/other' }]), /one workspace/);
});
