import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSubagentManager } from './web-subagent-manager.mjs';
import { NativeSwarmManager } from './native-swarm-manager.mjs';

test('mock independent host runs a concurrent swarm through artifacts, review, and source integration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgelink-swarm-host-source-'));
  const state = await mkdtemp(path.join(os.tmpdir(), 'forgelink-swarm-host-state-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'api.txt'), 'old api\n');
  await writeFile(path.join(root, 'ui.txt'), 'old ui\n');
  const started = [];
  const observed = [];
  const host = {
    capabilities: () => ({ provider: 'chatgpt_web', executionMode: 'independent_host_bridge', independentContexts: true,
      reasoningControl: 'unsupported_by_host', reasoningConfiguration: 'not_exposed', modelSelection: 'unsupported_by_host' }),
    async createSubagent(context) {
      started.push(context.role);
      return { contextId: `${context.role}-${context.agentId}`, context };
    },
    async waitForSubagent({ context }) {
      const call = context.executeTool;
      if (context.role === 'Backend') {
        const file = await call('fs_read', { path: 'api.txt', startLine: 1, endLine: 1 });
        await call('fs_replace', { path: 'api.txt', oldText: 'old api', newText: 'new api', expectedSha256: file.sha256 });
        await call('swarm_blackboard_write', { key: 'api_contract', value: { endpoint: '/items' }, expectedRevision: null });
        return { summary: 'Backend API is /items', files_changed: ['api.txt'] };
      }
      if (context.role === 'Frontend') {
        let contract;
        for (let attempt = 0; attempt < 100; attempt++) {
          contract = await call('swarm_blackboard_read', { key: 'api_contract' });
          if (contract) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(contract?.value.endpoint, '/items');
        observed.push('frontend consumed API contract');
        const file = await call('fs_read', { path: 'ui.txt', startLine: 1, endLine: 1 });
        await call('fs_replace', { path: 'ui.txt', oldText: 'old ui', newText: 'new ui using /items', expectedSha256: file.sha256 });
        return { summary: 'Frontend uses /items', files_changed: ['ui.txt'] };
      }
      if (context.role === 'Test reviewer') {
        assert.deepEqual(context.taskContext.dependencies.map((item) => item.taskKey).sort(), ['backend', 'frontend']);
        assert.ok(context.taskContext.dependencies.every((item) => item.result?.summary));
        observed.push('test reviewer consumed both artifacts');
        return { summary: 'Mock verification passed', tests_run: ['artifact contract check'], tests_passed: 1 };
      }
      assert.equal(context.role, 'Integration reviewer');
      assert.ok(context.taskContext.inputs.some((item) => item.summary === 'Backend API is /items'));
      assert.ok(context.taskContext.inputs.some((item) => item.summary === 'Frontend uses /items'));
      observed.push('integration reviewer consumed reviewed artifacts');
      return { summary: 'Integration approved after reviewing both artifacts' };
    },
    async cancelSubagent() {},
  };
  const subagents = new WebSubagentManager({ dataDir: path.join(state, 'workers'), host, concurrency: 4 });
  const swarm = new NativeSwarmManager({ dataDir: path.join(state, 'swarm'), subagents, maxConcurrency: 4,
    pollIntervalMs: 10, captureResources: async () => ({ cpu: 4, ram_mb: 8192, vram_mb: 0, processes: 8 }) });
  const created = await swarm.create({ objective: 'Implement an items API and UI', root, maxConcurrency: 4 });
  await swarm.plan(created.id, [
    { key: 'backend', prompt: 'Implement API', role: 'Backend', mode: 'write', readPaths: ['api.txt'], writePaths: ['api.txt'], blackboardWriteKeys: ['api_contract'] },
    { key: 'frontend', prompt: 'Implement UI', role: 'Frontend', mode: 'write', readPaths: ['ui.txt'], writePaths: ['ui.txt'], blackboardReadKeys: ['api_contract'] },
    { key: 'tests', prompt: 'Review both results', role: 'Test reviewer', dependencies: ['backend', 'frontend'], readPaths: ['.'] },
    { key: 'integration', prompt: 'Review integration', role: 'Integration reviewer', dependencies: ['tests'], inputs: ['backend', 'frontend'], readPaths: ['.'] },
  ]);
  await swarm.start(created.id);
  const beforeIntegration = await swarm.wait(created.id, 10000);
  assert.equal(beforeIntegration.status, 'review_required', JSON.stringify(beforeIntegration));
  const checkpoint = await swarm.checkpoint(created.id);
  assert.equal(checkpoint.tasks.length, 4);
  assert.equal(checkpoint.artifacts.length, 4);
  assert.ok(checkpoint.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.hash)));
  assert.ok(checkpoint.artifacts.find((artifact) => artifact.summary === 'Mock verification passed').dependencies.length === 2);
  assert.deepEqual(started.slice(0, 2).sort(), ['Backend', 'Frontend']);
  assert.equal(await readFile(path.join(root, 'api.txt'), 'utf8'), 'old api\n');
  assert.equal(await readFile(path.join(root, 'ui.txt'), 'utf8'), 'old ui\n');
  const review = await swarm.review(created.id);
  const backend = review.reports.find((item) => item.key === 'backend');
  const frontend = review.reports.find((item) => item.key === 'frontend');
  assert.ok(backend.reviewToken);
  assert.ok(frontend.reviewToken);
  await swarm.integrate(created.id, backend.taskId, ['api.txt'], backend.reviewToken, async () => true);
  await swarm.integrate(created.id, frontend.taskId, ['ui.txt'], frontend.reviewToken, async () => true);
  assert.equal((await swarm.status(created.id)).status, 'completed');
  assert.equal(await readFile(path.join(root, 'api.txt'), 'utf8'), 'new api\n');
  assert.equal(await readFile(path.join(root, 'ui.txt'), 'utf8'), 'new ui using /items\n');
  assert.deepEqual(observed, [
    'frontend consumed API contract', 'test reviewer consumed both artifacts', 'integration reviewer consumed reviewed artifacts',
  ]);
});
