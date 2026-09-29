import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SearchSessionManager } from './search-session-manager.mjs';

test('search sessions resume without dropping matches and only prove absence after complete traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-session-test-'));
  try {
    for (let index = 0; index < 6; index++) await fs.writeFile(path.join(root, `file-${index}.txt`), 'x');
    const sessions = new SearchSessionManager({ resolveDirectory: async (item) => item, validateRoot: async (item) => item });
    let cursor = sessions.create({ root, pattern: '*.txt', maxDepth: 0, prune: false, parallelism: 1 });
    const matches = [];
    for (let pageNumber = 0; pageNumber < 20 && cursor; pageNumber++) {
      const page = await sessions.page(cursor, { maxEntries: 1, maxResults: 1, maxTimeMs: 1000 });
      matches.push(...page.matches);
      if (!page.complete) assert.notEqual(page.status, 'not_found');
      cursor = page.nextCursor;
    }
    assert.equal(cursor, null);
    assert.equal(new Set(matches).size, 6);
    const noMatch = await sessions.find({ root, pattern: 'missing-*', maxDepth: 0, prune: false, parallelism: 1, maxScanEntries: 100, maxTimeMs: 2000 });
    assert.equal(noMatch.status, 'not_found');
    assert.equal(noMatch.complete, true);
    const nested = path.join(root, 'nested');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'MeeraAI.txt'), 'x');
    const basenameMatch = await sessions.find({ root, pattern: '*meera*', maxDepth: 2, prune: false, parallelism: 1, maxScanEntries: 100, maxTimeMs: 2000 });
    assert.equal(basenameMatch.matches.includes(path.join(nested, 'MeeraAI.txt')), true);
  } finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('forgelink-session-test-')) throw new Error('Unexpected test directory');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
