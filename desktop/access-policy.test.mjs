import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { assertRootGrantable, isDriveRoot, pathIsWithinRoot, requiresExtraConfirmation, selectAccessRoot } from './access-policy.mjs';

const win = path.win32;
const posix = path.posix;

test('path containment accepts descendants but blocks sibling-prefix traversal', () => {
  assert.equal(pathIsWithinRoot('C:\\Projects\\App', 'C:\\Projects\\App\\src', win), true);
  assert.equal(pathIsWithinRoot('C:\\Projects\\App', 'C:\\Projects\\App-old\\secret.txt', win), false);
  assert.equal(pathIsWithinRoot('C:\\Projects\\App', 'D:\\Projects\\App', win), false);
});

test('temporary read-only grants cannot authorize writes', () => {
  const roots = [];
  const grants = [{ root: 'C:\\Users\\Vidit\\Documents', access: 'read', expiresAt: 10_000 }];
  assert.equal(selectAccessRoot('C:\\Users\\Vidit\\Documents\\notes.txt', roots, grants, 'read', 9_000, win)?.access, 'read');
  assert.equal(selectAccessRoot('C:\\Users\\Vidit\\Documents\\notes.txt', roots, grants, 'write', 9_000, win), null);
});

test('write grants authorize both read and write until expiry', () => {
  const roots = [];
  const grants = [{ root: 'C:\\Users\\Vidit\\Desktop\\Project', access: 'read_write', expiresAt: 10_000 }];
  assert.equal(selectAccessRoot('C:\\Users\\Vidit\\Desktop\\Project\\main.js', roots, grants, 'read', 9_000, win)?.source, 'temporary');
  assert.equal(selectAccessRoot('C:\\Users\\Vidit\\Desktop\\Project\\main.js', roots, grants, 'write', 9_000, win)?.access, 'read_write');
  assert.equal(selectAccessRoot('C:\\Users\\Vidit\\Desktop\\Project\\main.js', roots, grants, 'read', 10_000, win), null);
});

test('persistent roots remain read/write and the most-specific matching root wins', () => {
  const roots = ['C:\\Users\\Vidit', 'C:\\Users\\Vidit\\Projects'];
  const match = selectAccessRoot('C:\\Users\\Vidit\\Projects\\App\\src', roots, [], 'write', 0, win);
  assert.equal(match.root, 'C:\\Users\\Vidit\\Projects');
  assert.equal(match.source, 'persistent');
});

test('a persistent read-only drive grant covers its tree but never authorizes writes', () => {
  const roots = [{ root: 'C:\\', access: 'read' }];
  assert.equal(selectAccessRoot('C:\\Users\\Vidit\\project\\src\\app.js', roots, [], 'read', 0, win)?.access, 'read');
  assert.equal(selectAccessRoot('C:\\Users\\Vidit\\project\\src\\app.js', roots, [], 'write', 0, win), null);
});

test('a narrower persistent write root overrides a broader read-only drive grant', () => {
  const roots = [{ root: 'C:\\', access: 'read' }, { root: 'C:\\Users\\Vidit\\project', access: 'read_write' }];
  assert.equal(selectAccessRoot('C:\\Users\\Vidit\\project\\src\\app.js', roots, [], 'write', 0, win)?.root, 'C:\\Users\\Vidit\\project');
  assert.equal(selectAccessRoot('C:\\Windows\\System32\\drivers\\etc\\hosts', roots, [], 'write', 0, win), null);
});

test('drive roots are recognized for the extra confirmation path', () => {
  assert.equal(isDriveRoot('C:\\', win), true);
  assert.equal(isDriveRoot('C:\\Users\\Vidit', win), false);
  assert.equal(requiresExtraConfirmation('C:\\', win), true);
  assert.equal(requiresExtraConfirmation('C:\\Users', win), true);
  assert.equal(requiresExtraConfirmation('C:\\Users\\Vidit', win), true);
  assert.equal(requiresExtraConfirmation('C:\\Windows\\System32', win), true);
  assert.equal(requiresExtraConfirmation('C:\\Users\\Vidit\\Projects\\App', win), false);
});

test('POSIX roots and path casing retain native semantics', () => {
  assert.equal(isDriveRoot('/', posix), true);
  assert.equal(isDriveRoot('/home', posix), false);
  assert.equal(requiresExtraConfirmation('/etc', posix), true);
  assert.equal(requiresExtraConfirmation('/usr/local', posix), true);
  assert.equal(pathIsWithinRoot('/home/Vidit/Project', '/home/Vidit/Project/src', posix), true);
  assert.equal(pathIsWithinRoot('/home/Vidit/Project', '/home/vidit/Project/src', posix), false);
  assert.equal(selectAccessRoot('/home/Vidit/Project/src', ['/home/Vidit/Project'], [], 'read', 0, posix)?.root, '/home/Vidit/Project');
  assert.equal(selectAccessRoot('/home/vidit/Project/src', ['/home/Vidit/Project'], [], 'read', 0, posix), null);
});

test('drive roots are accepted only on the explicitly approved persistent-root path', () => {
  assert.throws(() => assertRootGrantable('C:\\', false, win), /explicit owner approval/);
  assert.equal(assertRootGrantable('C:\\', true, win), 'C:\\');
  assert.equal(assertRootGrantable('C:\\Users\\Vidit', false, win), 'C:\\Users\\Vidit');
});
