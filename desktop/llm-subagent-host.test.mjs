import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatGPTWebHost } from './llm-subagent-host.mjs';
import { WebSubagentManager } from './web-subagent-manager.mjs';

async function ready(manager, count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (manager.webAssignments().length === count) return manager.webAssignments();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Assignments did not become ready');
}

test('ChatGPT Web handoff reports unavailable independent contexts and rejects unsupported reasoning', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgelink-host-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WebSubagentManager({ dataDir: path.join(root, 'state') });
  const capabilities = (await manager.providers()).providers[0].capabilities;
  assert.equal(capabilities.independentContexts, false);
  assert.equal(capabilities.reasoningControl, 'unsupported_by_host');
  assert.equal(capabilities.reasoningConfiguration, 'not_exposed');
  assert.throws(() => manager.submit([{ root, prompt: 'work', reasoning: { mode: 'enabled', effort: 'high' } }]), /reasoning control/);
  assert.throws(() => manager.submit([{ root, prompt: 'work', model: 'some-model' }]), /model selection/);
  const submitted = manager.submit([{ root, prompt: 'work' }]);
  const [assignment] = await ready(manager, 1);
  assert.equal(assignment.independentContext, false);
  assert.equal(assignment.reasoning.mode, 'default');
  await manager.finishWebTask(submitted.agents[0].id, { summary: 'done' }, { capabilityToken: submitted.agents[0].capabilityToken });
  await manager.wait(submitted.agents[0].id, 1000);
});

test('five independent mock host contexts run concurrently with separate workspaces and scoped tools', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgelink-host-parallel-'));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'forgelink-host-state-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); });
  for (let index = 0; index < 5; index++) await writeFile(path.join(root, `file-${index}.txt`), `content-${index}\n`);
  const contexts = [];
  let manager;
  const host = {
    capabilities: () => ({ provider: 'chatgpt_web', executionMode: 'independent_host_bridge', independentContexts: true,
      reasoningControl: 'supported', reasoningConfiguration: 'host_reported', modelSelection: 'unsupported_by_host' }),
    async createSubagent(context) {
      contexts.push(context);
      await assert.rejects(manager.invokeWebTool(context.agentId, 'fs_read', { path: context.readScopes[0], startLine: 1, endLine: 1 }), /Host-managed worker tools/);
      await assert.rejects(manager.finishWebTask(context.agentId, { summary: 'forged coordinator result' }), /Host-managed worker result/);
      return { contextId: `context-${context.agentId}`, context, reasoning: context.reasoning };
    },
    async waitForSubagent({ context }) {
      const own = context.readScopes[0];
      const read = await context.executeTool('fs_read', { path: own, startLine: 1, endLine: 1 });
      assert.match(read.lines[0].text, /content-/);
      const other = `file-${(Number(own.match(/\d+/)[0]) + 1) % 5}.txt`;
      await assert.rejects(context.executeTool('fs_read', { path: other, startLine: 1, endLine: 1 }), /scope|allowed|forbidden|outside/i);
      return { status: 'completed', summary: `Read ${own}` };
    },
    async cancelSubagent() {},
  };
  manager = new WebSubagentManager({ dataDir, host, concurrency: 5 });
  const batch = manager.submit(Array.from({ length: 5 }, (_, index) => ({ root,
    prompt: `Read file ${index}`, readPaths: [`file-${index}.txt`], reasoning: { mode: 'enabled', effort: 'high' } })));
  const results = await Promise.all(batch.agents.map(({ id }) => manager.wait(id, 5000)));
  assert.ok(results.every((record) => record.state === 'completed'), JSON.stringify(results));
  assert.equal(contexts.length, 5);
  assert.equal(new Set(contexts.map((context) => context.workspaceRoot)).size, 5);
  assert.ok(contexts.every((context) => context.reasoning.effort === 'high'));
  assert.deepEqual(manager.webAssignments(), []);
});

test('structured resume packet survives manager restart without model reasoning', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgelink-host-checkpoint-'));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'forgelink-host-checkpoint-state-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'work.txt'), 'work\n');
  const manager = new WebSubagentManager({ dataDir });
  const worker = manager.submit([{ root, prompt: 'Inspect work.txt', readPaths: ['work.txt'] }]).agents[0];
  const id = worker.id;
  await ready(manager, 1);
  await manager.checkpointWebTask(id, { completedWork: ['Read work.txt'], remainingWork: ['Report findings'], nextRecommendedAction: 'Report findings' }, { capabilityToken: worker.capabilityToken });
  const replacement = new WebSubagentManager({ dataDir });
  const packet = await replacement.resumePacket(id);
  assert.equal(packet.agentId, id);
  assert.deepEqual(packet.completedWork, ['Read work.txt']);
  assert.equal(packet.nextRecommendedAction, 'Report findings');
  assert.equal(packet.reasoning.actual, 'not_exposed');
  assert.equal(Object.hasOwn(packet, 'hiddenReasoning'), false);
  await manager.finishWebTask(id, { summary: 'done' }, { capabilityToken: worker.capabilityToken });
  await manager.wait(id, 1000);
});

test('an independent host cannot silently drop requested reasoning effort', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgelink-host-reasoning-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let cancelled = 0;
  const host = {
    capabilities: () => ({ independentContexts: true, reasoningControl: 'supported', modelSelection: 'unsupported_by_host' }),
    async createSubagent() { return { contextId: 'separate-context', reasoning: { mode: 'default' } }; },
    async waitForSubagent() { throw new Error('Must not run without reasoning attestation'); },
    async cancelSubagent() { cancelled++; },
  };
  const manager = new WebSubagentManager({ dataDir: path.join(root, 'state'), host });
  const id = manager.submit([{ root, prompt: 'Reason carefully', reasoning: { mode: 'enabled', effort: 'high' } }]).agents[0].id;
  const result = await manager.wait(id, 1000);
  assert.equal(result.state, 'failed');
  assert.match(result.result.summary, /did not attest the requested reasoning configuration/);
  assert.equal(cancelled, 1);
});

test('cancelling a host-managed worker cancels its independent context', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgelink-host-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let created;
  let cancelled;
  const host = {
    capabilities: () => ({ independentContexts: true, reasoningControl: 'unsupported_by_host', modelSelection: 'unsupported_by_host' }),
    async createSubagent() { created = { contextId: 'cancel-test-context' }; return created; },
    async waitForSubagent(_context, { signal }) {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    },
    async cancelSubagent(context) { cancelled = context; },
  };
  const manager = new WebSubagentManager({ dataDir: path.join(root, 'state'), host });
  const id = manager.submit([{ root, prompt: 'Wait until cancelled' }]).agents[0].id;
  for (let attempt = 0; attempt < 100 && !created; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(created);
  assert.equal(manager.cancel(id).state, 'cancelled');
  for (let attempt = 0; attempt < 100 && !cancelled; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cancelled.contextId, created.contextId);
});
