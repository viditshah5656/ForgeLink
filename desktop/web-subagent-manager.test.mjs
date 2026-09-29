import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSubagentManager } from './web-subagent-manager.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgelink-web-agent-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const applied = [];
  const workspaceFactory = async () => ({
    root, async diff() { return { files: [{ path: 'a.txt', status: 'modified' }], patch: 'test patch' }; },
    async apply(options) { applied.push(options); return { applied: options.paths }; },
    async dispose() {},
  });
  const toolsFactory = ({ writePaths }) => ({ specs: [], execute: async () => null,
    scopes: { writePaths: writePaths.map((entry) => ({ path: path.join(root, entry), kind: 'file' })) } });
  const manager = new WebSubagentManager({ dataDir: root, apiKey: 'test-api-key', concurrency: 15,
    runtime: async () => ({ status: 'completed', output: 'done', usage: { totalTokens: 1 }, turns: 1, toolCalls: [] }),
    workspaceFactory, toolsFactory, ...overrides });
  return { manager, root, applied };
}

async function assignmentFor(manager, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const assignment = manager.webAssignments({ limit: 15 }).find((entry) => entry.id === id);
    if (assignment) return assignment;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Worker assignment did not become ready: ${id}`);
}

async function finishWorker(manager, id, capabilityToken, result = { summary: 'done' }) {
  await assignmentFor(manager, id);
  await manager.finishWebTask(id, result, { capabilityToken });
  return manager.wait(id, 1000);
}

test('fifteen scoped ChatGPT Web handoff assignments can occupy all scheduler slots', async (t) => {
  const { manager, root } = await fixture(t);
  const batch = manager.submit(Array.from({ length: 15 }, (_, index) => ({ root, prompt: `Task ${index}`, mode: 'read' })));
  let assignments = [];
  for (let tries = 0; tries < 100 && assignments.length < 15; tries++) {
    assignments = manager.webAssignments({ groupId: batch.groupId, limit: 15 });
    if (assignments.length < 15) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(assignments.length, 15);
  assert.equal(manager.stats().occupied, 15);
  await Promise.all(batch.agents.map(({ id, capabilityToken }) => manager.finishWebTask(id, { summary: 'done' }, { capabilityToken })));
  const results = await Promise.all(batch.agents.map((item) => manager.wait(item.id, 1000)));
  assert.ok(results.every((item) => item.state === 'completed'));
  assert.equal(manager.stats().occupied, 0);
});

test('write scopes cannot overlap within or across active batches', async (t) => {
  const { manager, root } = await fixture(t);
  const write = (name) => ({ root, prompt: name, mode: 'write', writePaths: [name] });
  assert.throws(() => manager.submit([write('a.txt'), write('a.txt')]), /overlap/);
  const first = manager.submit([write('a.txt')]);
  assert.throws(() => manager.submit([write('a.txt')]), /overlap/);
  await finishWorker(manager, first.agents[0].id, first.agents[0].capabilityToken);
  await manager.wait(first.agents[0].id, 1000);
  assert.equal(manager.result(first.agents[0].id).state, 'completed');
});

test('review token and selected write scope gate source application', async (t) => {
  const { manager, root, applied } = await fixture(t);
  const batch = manager.submit([{ root, prompt: 'Change a', mode: 'write', writePaths: ['a.txt'] }]);
  const id = batch.agents[0].id;
  await finishWorker(manager, id, batch.agents[0].capabilityToken);
  await manager.wait(id, 1000);
  await assert.rejects(manager.apply(id, ['a.txt'], 'invalid', async () => true), /review token/);
  const review = await manager.review(id);
  await assert.rejects(manager.apply(id, ['b.txt'], review.reviewToken, async () => true), /write scope/);
  const result = await manager.apply(id, ['a.txt'], review.reviewToken, async () => true);
  assert.deepEqual(result.applied, ['a.txt']);
  assert.equal(applied.length, 1);
  await assert.rejects(manager.apply(id, ['a.txt'], review.reviewToken, async () => true), /already been applied/);
});

test('workers default to ChatGPT Web and remain cancellable without model setup', async (t) => {
  const { root } = await fixture(t);
  const manager = new WebSubagentManager({ dataDir: root });
  assert.equal(manager.stats().nativeRuntimeAvailable, false);
  const submitted = manager.submit([{ root, prompt: 'inspect' }]);
  const assignment = await assignmentFor(manager, submitted.agents[0].id);
  assert.equal(assignment.prompt, 'inspect');
  assert.equal(manager.result(assignment.id).metadata.provider, 'chatgpt_web');
  assert.equal(manager.cancel(submitted.agents[0].id).state, 'cancelled');
  for (let attempt = 0; attempt < 100 && manager.stats().occupied; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(manager.stats().occupied, 0);
});

test('ChatGPT Web assignments execute only assigned tools and finish into an isolated reviewable result', async (t) => {
  const { manager, root } = await fixture(t, {
    toolsFactory: () => ({
      specs: [{ type: 'function', name: 'fs_read', description: 'Read assigned file', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      execute: async (name, args) => { assert.equal(name, 'fs_read'); return { path: args.path, content: 'scoped' }; },
      scopes: { writePaths: [] },
    }),
  });
  const { agents, groupId } = manager.submit([{ root, prompt: 'Inspect assigned files', provider: 'chatgpt_web' }]);
  const id = agents[0].id;
  let assignments;
  for (let attempt = 0; attempt < 40; attempt++) {
    assignments = manager.webAssignments({ groupId });
    if (assignments.length) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].id, id);
  assert.equal(assignments[0].prompt, 'Inspect assigned files');
  assert.ok(assignments[0].tools.some((tool) => tool.name === 'fs_read'));
  const capabilityToken = agents[0].capabilityToken;
  await assert.rejects(manager.invokeWebTool(id, 'fs_write', {}, { capabilityToken }), /not assigned/);
  assert.deepEqual(await manager.invokeWebTool(id, 'fs_read', { path: 'README.md' }, { capabilityToken }), { path: 'README.md', content: 'scoped' });
  await manager.finishWebTask(id, { summary: 'Inspection complete', files_changed: [], tests_run: ['none'] }, { capabilityToken });
  const completed = await manager.wait(id, 1000);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result.provider, 'chatgpt_web');
  assert.equal(completed.result.summary, 'Inspection complete');
  assert.equal(manager.webAssignments({ groupId }).length, 0);
  assert.equal((await manager.providers()).providers[0].id, 'chatgpt_web');
});

test('direct worker capabilities authorize only their own assignment and stay out of listings', async (t) => {
  const { manager, root } = await fixture(t, {
    toolsFactory: () => ({
      specs: [{ type: 'function', name: 'fs_read', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
      execute: async () => ({ content: 'scoped' }), scopes: { writePaths: [] },
    }),
  });
  const { agents } = manager.submit([
    { root, prompt: 'Inspect a', readPaths: ['a.txt'] },
    { root, prompt: 'Inspect b', readPaths: ['b.txt'] },
  ]);
  const [first, second] = agents;
  await Promise.all(agents.map(({ id }) => assignmentFor(manager, id)));
  assert.match(first.capabilityToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second.capabilityToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.capabilityToken, second.capabilityToken);
  assert.equal(JSON.stringify(manager.webAssignments()).includes(first.capabilityToken), false);
  assert.equal(JSON.stringify(manager.status(first.id)).includes(first.capabilityToken), false);
  await assert.rejects(manager.invokeWebTool(first.id, 'fs_read', {}), /Invalid worker capability/);
  await assert.rejects(manager.invokeWebTool(first.id, 'fs_read', {}, { capabilityToken: second.capabilityToken }), /Invalid worker capability/);
  assert.throws(() => manager.heartbeatWebTask(first.id, { capabilityToken: second.capabilityToken }), /Invalid worker capability/);
  await assert.rejects(manager.checkpointWebTask(first.id, { completedWork: ['forged'] }, { capabilityToken: second.capabilityToken }), /Invalid worker capability/);
  await assert.rejects(manager.finishWebTask(first.id, { summary: 'forged' }, { capabilityToken: second.capabilityToken }), /Invalid worker capability/);
  assert.throws(() => manager.nativeSpawnPacket(first.id, second.capabilityToken), /Invalid worker capability/);
  const packet = manager.nativeSpawnPacket(first.id, first.capabilityToken);
  assert.equal(packet.workerId, first.id);
  assert.equal(packet.capabilityToken, first.capabilityToken);
  assert.deepEqual(packet.readPaths, ['a.txt']);
  assert.ok(packet.tools.some((tool) => tool.name === 'fs_read'));
  assert.equal(packet.independentContext, 'client_owned_unverified');
  assert.deepEqual(await manager.invokeWebTool(first.id, 'fs_read', {}, { capabilityToken: first.capabilityToken }), { content: 'scoped' });
  await manager.checkpointWebTask(first.id, { completedWork: ['read a'] }, { capabilityToken: first.capabilityToken });
  assert.equal(JSON.stringify(await manager.resumePacket(first.id)).includes(first.capabilityToken), false);
  await Promise.all(agents.map(({ id, capabilityToken }) => manager.finishWebTask(id, { summary: 'done' }, { capabilityToken })));
  assert.ok((await Promise.all(agents.map(({ id }) => manager.wait(id, 1000)))).every((item) => item.state === 'completed'));
});

test('durable swarm coordinator handoffs retain their existing tokenless worker protocol', async (t) => {
  const { manager, root } = await fixture(t);
  const { agents } = manager.submit([{ root, prompt: 'Swarm step', swarmId: 'swarm-a', taskId: 'task-a' }]);
  const assignment = await assignmentFor(manager, agents[0].id);
  assert.equal(agents[0].capabilityToken, undefined);
  assert.equal(assignment.capabilityToken, undefined);
  await manager.finishWebTask(agents[0].id, { summary: 'done' });
  assert.equal((await manager.wait(agents[0].id, 1000)).state, 'completed');
});

test('native child delegation narrows parent scopes and tools across nested read workers', async (t) => {
  const { manager, root } = await fixture(t, {
    toolsFactory: () => ({
      specs: [
        { type: 'function', name: 'fs_read', parameters: { type: 'object', properties: {}, additionalProperties: false } },
        { type: 'function', name: 'fs_search', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      ],
      execute: async (name) => ({ name }), scopes: { writePaths: [] },
    }),
  });
  const parent = manager.submit([{ root, prompt: 'Inspect project', readPaths: ['project'] }]).agents[0];
  await assignmentFor(manager, parent.id);
  const childSpec = { objective: 'Read module', readPaths: ['project/module'], tools: ['fs_read'] };
  assert.throws(() => manager.spawnChild(parent.id, 'wrong-token', childSpec), /Invalid worker capability/);
  assert.throws(() => manager.spawnChild(parent.id, parent.capabilityToken,
    { ...childSpec, readPaths: ['other'] }), /exceeds parent grant/);
  assert.throws(() => manager.spawnChild(parent.id, parent.capabilityToken,
    { ...childSpec, tools: ['fs_write'] }), /exceeds parent grant/);
  assert.throws(() => manager.spawnChild(parent.id, parent.capabilityToken,
    { ...childSpec, mode: 'write', writePaths: ['project/module'] }), /read-only/);
  assert.throws(() => manager.spawnChild(parent.id, parent.capabilityToken,
    { ...childSpec, processAccess: true }), /process access/);
  const child = manager.spawnChild(parent.id, parent.capabilityToken, childSpec);
  await assignmentFor(manager, child.id);
  assert.equal(child.parentId, parent.id);
  assert.equal(child.depth, 1);
  assert.deepEqual(manager.nativeSpawnPacket(child.id, child.capabilityToken).tools.map((tool) => tool.name), ['fs_read']);
  await assert.rejects(manager.invokeWebTool(child.id, 'fs_search', {}, { capabilityToken: child.capabilityToken }), /not assigned/);
  assert.throws(() => manager.spawnChild(child.id, child.capabilityToken,
    { objective: 'Regain parent search tool', readPaths: ['project/module'], tools: ['fs_search'] }), /exceeds parent grant/);
  assert.deepEqual(await manager.invokeWebTool(child.id, 'fs_read', {}, { capabilityToken: child.capabilityToken }), { name: 'fs_read' });
  const grandchild = manager.spawnChild(child.id, child.capabilityToken,
    { objective: 'Read one file', readPaths: ['project/module/a.txt'], tools: ['fs_read'] });
  await assignmentFor(manager, grandchild.id);
  assert.equal(grandchild.parentId, child.id);
  assert.equal(grandchild.depth, 2);
  await Promise.all([parent, child, grandchild].map(({ id, capabilityToken }) =>
    manager.finishWebTask(id, { summary: 'done' }, { capabilityToken })));
  assert.ok((await Promise.all([parent, child, grandchild].map(({ id }) => manager.wait(id, 1000))))
    .every((item) => item.state === 'completed'));
});

test('native read-only children reject write tools even when the parent can use them', async (t) => {
  const { manager, root } = await fixture(t, {
    toolsFactory: () => ({
      specs: [
        { type: 'function', name: 'fs_read', parameters: { type: 'object', properties: {}, additionalProperties: false } },
        { type: 'function', name: 'fs_write', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      ],
      execute: async (name) => ({ name }), scopes: { writePaths: [] },
    }),
  });
  const parent = manager.submit([{ root, prompt: 'Edit a file', mode: 'write',
    readPaths: ['a.txt'], writePaths: ['a.txt'] }]).agents[0];
  await assignmentFor(manager, parent.id);
  assert.throws(() => manager.spawnChild(parent.id, parent.capabilityToken,
    { objective: 'Attempt edit', readPaths: ['a.txt'], tools: ['fs_write'] }), /read-only child/);
  await finishWorker(manager, parent.id, parent.capabilityToken);
});

test('native child depth and descendant budgets are configurable', async (t) => {
  const { manager, root } = await fixture(t, { maxNativeChildDepth: 1, maxNativeDescendants: 1 });
  const parent = manager.submit([{ root, prompt: 'Inspect', readPaths: ['.'] }]).agents[0];
  await assignmentFor(manager, parent.id);
  const request = { objective: 'Read one file', readPaths: ['a.txt'], tools: [] };
  const child = manager.spawnChild(parent.id, parent.capabilityToken, request);
  await assignmentFor(manager, child.id);
  assert.throws(() => manager.spawnChild(parent.id, parent.capabilityToken, request), /count exceeds 1/);
  assert.throws(() => manager.spawnChild(child.id, child.capabilityToken, request), /depth exceeds 1/);
  await Promise.all([parent, child].map(({ id, capabilityToken }) =>
    manager.finishWebTask(id, { summary: 'done' }, { capabilityToken })));
  assert.ok((await Promise.all([parent, child].map(({ id }) => manager.wait(id, 1000))))
    .every((item) => item.state === 'completed'));
});

test('ChatGPT Web handoffs stay active beyond timeoutMs when the coordinator heartbeats', async (t) => {
  const { manager, root } = await fixture(t);
  const { agents } = manager.submit([{ root, prompt: 'Long reasoning task', timeoutMs: 1000 }]);
  const id = agents[0].id;
  await assignmentFor(manager, id);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(manager.heartbeatWebTask(id, { capabilityToken: agents[0].capabilityToken }).state, 'running');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(manager.status(id).state, 'running');
  await manager.finishWebTask(id, { summary: 'Finished after heartbeat renewal' }, { capabilityToken: agents[0].capabilityToken });
  assert.equal((await manager.wait(id, 1000)).state, 'completed');
});

test('a failed ChatGPT Web worker becomes failed with its structured result', async (t) => {
  const { manager, root } = await fixture(t);
  const { agents } = manager.submit([{ root, prompt: 'Inspect', provider: 'chatgpt_web' }]);
  const id = agents[0].id;
  for (let attempt = 0; attempt < 40 && !manager.webAssignments().length; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  await manager.finishWebTask(id, { status: 'failed', summary: 'Could not complete safely', blockers: ['required file missing'] }, { capabilityToken: agents[0].capabilityToken });
  const failed = await manager.wait(id, 1000);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result.summary, 'Could not complete safely');
  assert.equal(failed.result.blockers[0], 'required file missing');
});

test('ChatGPT Web worker assignments occupy scheduler slots concurrently and cancel as a group', async (t) => {
  const { manager, root } = await fixture(t);
  const { agents, groupId } = manager.submit(Array.from({ length: 6 }, (_, index) => ({
    root, prompt: `Independent task ${index}`, provider: 'chatgpt_web',
  })));
  let assignments = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    assignments = manager.webAssignments({ groupId, limit: 15 });
    if (assignments.length === 6) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(assignments.length, 6);
  assert.equal(manager.stats().occupied, 6);
  assert.equal(new Set(assignments.map((item) => item.id)).size, 6);
  assert.equal(manager.cancelGroup(groupId), 6);
  const final = await Promise.all(agents.map(({ id }) => manager.wait(id, 1000)));
  assert.ok(final.every((item) => item.state === 'cancelled'));
  for (let attempt = 0; attempt < 40 && manager.stats().occupied; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(manager.stats().occupied, 0);
});

test('swarm workers receive only host-validated communication extensions alongside scoped file tools', async (t) => {
  const { manager, root } = await fixture(t, {
    toolsFactory: ({ writePaths }) => ({ specs: [{ type: 'function', name: 'fs_read', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }], execute: async () => null,
      scopes: { writePaths: writePaths.map((entry) => ({ path: path.join(root, entry), kind: 'file' })) } }),
    agentToolsFactory: ({ swarmId, taskId, agentId }) => ({
      specs: [{ type: 'function', name: 'agent_message_list', description: 'messages', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      execute: async (name) => ({ name, swarmId, taskId, agentId }),
    }),
  });
  const submitted = manager.submit([{ root, prompt: 'inspect', swarmId: 'swarm_test', taskId: 'task_test' }]);
  const id = submitted.agents[0].id;
  const assignment = await assignmentFor(manager, id);
  assert.ok(assignment.tools.some((item) => item.name === 'fs_read'));
  assert.ok(assignment.tools.some((item) => item.name === 'agent_message_list'));
  const message = await manager.invokeWebTool(id, 'agent_message_list', {}, { capabilityToken: submitted.agents[0].capabilityToken });
  await manager.finishWebTask(id, { summary: JSON.stringify(message) }, { capabilityToken: submitted.agents[0].capabilityToken });
  const result = await manager.wait(id, 1000);
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.match(result.result.summary, /"swarmId":"swarm_test"/);
  assert.throws(() => manager.submit([{ root, prompt: 'broken', swarmId: 'swarm_test' }]), /both swarmId and taskId/);
});

test('native workers receive task process tools only after an explicit grant and dispose them when done', async (t) => {
  let disposed = 0;
  const { manager, root } = await fixture(t, {
    processToolsFactory: ({ root: workspaceRoot, owner, signal }) => {
      assert.ok(workspaceRoot);
      assert.ok(owner);
      assert.ok(signal);
      return { specs: [{ type: 'function', name: 'process_start', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
        execute: async () => ({ started: true }), dispose() { disposed++; } };
    },
  });
  const { agents } = manager.submit([{ root, prompt: 'run a check', processAccess: true }]);
  const assignment = await assignmentFor(manager, agents[0].id);
  assert.ok(assignment.tools.some((tool) => tool.name === 'process_start'));
  assert.deepEqual(await manager.invokeWebTool(agents[0].id, 'process_start', {}, { capabilityToken: agents[0].capabilityToken }), { started: true });
  await manager.finishWebTask(agents[0].id, { summary: 'process tool smoke' }, { capabilityToken: agents[0].capabilityToken });
  const done = await manager.wait(agents[0].id, 1000);
  assert.equal(done.state, 'completed');
  assert.equal(disposed, 1);
  assert.throws(() => manager.submit([{ root, prompt: 'not supported', processAccess: true, provider: 'codex' }]), /ChatGPT Web MCP host/);
});

test('real scoped tools edit only a snapshot until reviewed changes are applied', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgelink-web-agent-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'a.txt');
  await writeFile(file, 'old text\n');
  const manager = new WebSubagentManager({ dataDir: path.join(root, 'agent-data') });
  const { agents } = manager.submit([{ root, prompt: 'Change a.txt', mode: 'write', readPaths: ['.'], writePaths: ['a.txt'] }]);
  const id = agents[0].id;
  await assignmentFor(manager, id);
  const capabilityToken = agents[0].capabilityToken;
  const before = await manager.invokeWebTool(id, 'fs_read', { path: 'a.txt', startLine: 1, endLine: 2 }, { capabilityToken });
  await manager.invokeWebTool(id, 'fs_replace', { path: 'a.txt', oldText: 'old text', newText: 'new text', expectedSha256: before.sha256 }, { capabilityToken });
  await manager.finishWebTask(id, { summary: 'Changed a.txt in my snapshot' }, { capabilityToken });
  const completed = await manager.wait(id, 5000);
  assert.equal(completed.state, 'completed');
  assert.deepEqual((await manager.resumePacket(id)).filesChanged, ['a.txt']);
  assert.equal(await readFile(file, 'utf8'), 'old text\n');
  const review = await manager.review(id);
  assert.deepEqual(review.changes.files.map((item) => item.path), ['a.txt']);
  await manager.apply(id, ['a.txt'], review.reviewToken, async (target) => target === file);
  assert.equal(await readFile(file, 'utf8'), 'new text\n');
  assert.deepEqual(await manager.discard(id), { id, discarded: true });
});
