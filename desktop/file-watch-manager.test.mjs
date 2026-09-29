import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileWatchManager } from './file-watch-manager.mjs';

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for file watch event');
}

test('native file watch filters paths and honors pause, resume, and stop', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-watch-test-'));
  const events = [];
  const manager = new FileWatchManager({ publish: (event) => events.push(event) });
  try {
    const watch = manager.create({ root, recursive: false, includePatterns: ['*.py'] });
    const source = path.join(root, 'sample.py');
    await fs.writeFile(path.join(root, 'ignored.txt'), 'ignored');
    await fs.writeFile(source, 'print(1)');
    await until(() => events.some((event) => event.type.startsWith('file.') && event.path === source));
    assert.equal(events.some((event) => event.path?.endsWith('ignored.txt')), false);

    manager.pause(watch.watchId);
    const count = events.filter((event) => event.type.startsWith('file.')).length;
    await fs.writeFile(source, 'print(2)');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(events.filter((event) => event.type.startsWith('file.')).length, count);

    manager.resume(watch.watchId);
    await fs.writeFile(source, 'print(3)');
    await until(() => events.filter((event) => event.type.startsWith('file.')).length > count);
    const renamed = path.join(root, 'renamed.py');
    await fs.rename(source, renamed);
    await until(() => events.some((event) => event.type === 'file.renamed' && event.path === renamed));
    assert.equal(events.find((event) => event.type === 'file.renamed' && event.path === renamed).fromPath, source);
    const subfolder = path.join(root, 'subfolder');
    await fs.mkdir(subfolder);
    const moved = path.join(subfolder, 'renamed.py');
    await fs.rename(renamed, moved);
    await manager.flush(manager.get(watch.watchId), moved, 'rename');
    assert.equal(events.find((event) => event.type === 'file.moved' && event.path === moved)?.fromPath, renamed);
    assert.equal(manager.stop(watch.watchId).status, 'stopped');
    assert.deepEqual(manager.list(), []);
  } finally {
    manager.stopAll();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('forgelink-watch-test-')) throw new Error('Refusing to remove an unexpected test directory');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
