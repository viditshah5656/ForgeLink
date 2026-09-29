import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { buildRoutedContext, NativeSwarmManager } from './native-swarm-manager.mjs';

function fakeSubagents() {
  const records = new Map();
  let nextId = 0;
  return {
    records,
    submit(tasks) {
      const id = `agent-${++nextId}`;
      records.set(id, { state: 'waiting_for_provider', result: { status: 'waiting_for_provider', reason: 'The configured provider is unavailable' } });
      return { agents: [{ id }] };
    },
    status(id) { return structuredClone(records.get(id)); },
    result(id) { return structuredClone(records.get(id)); },
    cancel(id) { records.set(id, { state: 'cancelled' }); },
    orchestrator: { resume(id) { records.set(id, { state: 'running' }); } },
    async review() { return { reviewToken: 'a'.repeat(64) }; },
    async apply() { return { applied: ['src/a.js'] }; },
  };
}

test('task context routes only the objective, declared dependencies, and explicit artifact inputs', () => {
  const swarm = { objective: 'Improve authentication', tasks: [
    { id: 'task-a', key: 'research', title: 'Research auth', state: 'completed' },
    { id: 'task-b', key: 'unrelated', title: 'Unrelated database task', state: 'completed' },
  ], artifacts: [
    { id: 'artifact-a', taskId: 'task-a', type: 'research', summary: 'Found token expiry bug', files: ['src/auth.js'], content: { summary: 'Refresh token lacks expiry check' } },
    { id: 'artifact-b', taskId: 'task-b', type: 'research', summary: 'Database notes', files: [], content: { private: 'unrelated result' } },
  ] };
  const routed = buildRoutedContext(swarm, { dependencies: ['research'], inputs: ['artifact-a'] });
  assert.equal(routed.objective, 'Improve authentication');
  assert.equal(routed.dependencies.length, 1);
  assert.equal(routed.dependencies[0].result.content.summary, 'Refresh token lacks expiry check');
  assert.equal(routed.inputs[0].summary, 'Found token expiry bug');
  assert.equal(JSON.stringify(routed).includes('unrelated'), false);
});

test('durable swarm validates a DAG, parks missing providers, and recovers safely after restart', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-swarm-'));
  const subagents = fakeSubagents();
  const manager = new NativeSwarmManager({ dataDir, subagents, maxConcurrency: 4, pollIntervalMs: 10,
    captureResources: async () => ({ cpu: 4, ram_mb: 4096, vram_mb: 0, processes: 128 }) });
  t.after(async () => { await manager.cancel([...manager.swarms.keys()][0]).catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  const swarm = await manager.create({ objective: 'Implement and verify a change', root: dataDir, maxConcurrency: 4, baseline: { gitStatus: 'clean' } });
  await manager.plan(swarm.id, [
    { key: 'inspect', title: 'Inspect', prompt: 'Inspect the relevant files', readPaths: ['.'], blackboardReadKeys: ['architecture'], blackboardWriteKeys: ['findings'] },
    { key: 'implement', title: 'Implement', prompt: 'Implement the reviewed change', dependencies: ['inspect'], mode: 'write', readPaths: ['.'], writePaths: ['src'] },
  ]);
  await assert.rejects(manager.plan(swarm.id, [
    { key: 'cycle-a', prompt: 'a', dependencies: ['cycle-b'] },
    { key: 'cycle-b', prompt: 'b', dependencies: ['cycle-a'] },
  ]), /cycle/i);
  await manager.start(swarm.id);
  const parked = await manager.wait(swarm.id, 1000);
  assert.equal(parked.status, 'waiting_for_provider');
  const tasks = await manager.taskList(swarm.id);
  assert.equal(tasks.find((task) => task.key === 'inspect').state, 'waiting_for_provider');
  assert.equal(tasks.find((task) => task.key === 'implement').state, 'pending');
  const parent = tasks.find((task) => task.key === 'inspect');
  const workerTools = manager.createAgentTools({ swarmId: swarm.id, taskId: parent.id, agentId: parent.assignedAgentId });
  assert.ok(workerTools.specs.some((tool) => tool.name === 'swarm_blackboard_read' && tool.parameters.properties.key.enum.join() === 'architecture,findings'));
  assert.ok(workerTools.specs.some((tool) => tool.name === 'swarm_blackboard_write' && tool.parameters.properties.key.enum.join() === 'findings'));
  assert.equal(workerTools.specs.some((tool) => tool.name === 'swarm_blackboard_delete'), false);
  const stored = await workerTools.execute('swarm_blackboard_write', { key: 'findings', value: { issue: 'auth flow' }, expectedRevision: null });
  assert.equal((await workerTools.execute('swarm_blackboard_read', { key: 'findings' })).revision, stored.revision);
  await assert.rejects(workerTools.execute('swarm_blackboard_read', { key: 'ungranted' }), /not granted/);
  await assert.rejects(manager.blackboardWrite(swarm.id, 'findings', { issue: 'stale' }, { agentId: parent.assignedAgentId, taskId: parent.id, expectedRevision: 0 }), /revision conflict/);
  await workerTools.execute('agent_memory_write', { scope: 'task', key: 'decision', value: { language: 'js' } });
  assert.equal((await workerTools.execute('agent_memory_read', { scope: 'task', key: 'decision' })).value.language, 'js');
  const message = await workerTools.execute('agent_message_send', { toAgentId: null, messageType: 'STATUS', priority: 'NORMAL', payload: { note: 'auth flow inspected' } });
  assert.equal((await workerTools.execute('agent_message_list', {})).messages[0].id, message.id);
  assert.equal((await workerTools.execute('agent_message_ack', { messageId: message.id })).acknowledged, true);

  subagents.records.set(parent.assignedAgentId, { state: 'running' });
  await manager.resume(swarm.id);
  for (let i = 0; i < 50 && (await manager.taskStatus(swarm.id, parent.id)).state !== 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const childResult = await workerTools.execute('agent_spawn_child', { key: 'child-research', title: 'Research auth', prompt: 'Inspect the auth implementation', role: 'Researcher', readPaths: ['.'], priority: 'NORMAL', blackboardReadKeys: ['architecture'], blackboardWriteKeys: [] });
  assert.equal(childResult.parentTaskId, parent.id);
  assert.ok(childResult.agentId);
  await assert.rejects(manager.spawnChildAgent({ swarmId: swarm.id, parentAgentId: parent.assignedAgentId, parentTaskId: parent.id,
    child: { key: 'child-process', prompt: 'Run arbitrary code', readPaths: ['.'], processAccess: true } }), /inherited from a parent/);
  await assert.rejects(manager.spawnChildAgent({ swarmId: swarm.id, parentAgentId: parent.assignedAgentId, parentTaskId: parent.id,
    child: { key: 'out-of-scope', prompt: 'Escape', readPaths: [path.dirname(dataDir)] } }), /Scope must be|escapes|exceeds parent capability/);
  subagents.records.set(parent.assignedAgentId, { state: 'waiting_for_provider', result: { status: 'waiting_for_provider', reason: 'Model paused' } });
  assert.equal((await manager.wait(swarm.id, 1000)).status, 'waiting_for_provider');

  const recovered = new NativeSwarmManager({ dataDir, subagents, pollIntervalMs: 10 });
  const recoveredStatus = await recovered.status(swarm.id);
  assert.equal(recoveredStatus.status, 'paused');
  const recoveredTasks = await recovered.taskList(swarm.id);
  assert.equal(recoveredTasks.find((task) => task.key === 'inspect').state, 'pending');
  assert.match(recoveredTasks.find((task) => task.key === 'inspect').error, /restart/i);
  const recoveryEvents = await recovered.events(swarm.id);
  assert.ok(recoveryEvents.events.some((event) => event.type === 'task.recovered' && event.taskKey === 'inspect'));
  assert.ok(recoveryEvents.events.some((event) => event.type === 'swarm.recovered' && event.interruptedTaskIds.includes(parent.id)));
});

test('provider-waiting agents do not block independent dependency-ready tasks', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-provider-parallel-'));
  let manager;
  let swarm;
  const subagents = fakeSubagents();
  t.after(async () => {
    if (manager && swarm) await manager.cancel(swarm.id).catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  manager = new NativeSwarmManager({ dataDir, subagents, maxConcurrency: 4, pollIntervalMs: 10,
    captureResources: async () => ({ cpu: 8, ram_mb: 8192, vram_mb: 0, processes: 128 }) });
  swarm = await manager.create({ objective: 'Schedule independent tasks despite missing inference', root: dataDir, maxConcurrency: 4 });
  await manager.plan(swarm.id, [
    { key: 'first', prompt: 'First independent task' },
    { key: 'second', prompt: 'Second independent task' },
  ]);
  await manager.start(swarm.id);
  const state = await manager.wait(swarm.id, 1000);
  assert.equal(state.status, 'waiting_for_provider');
  const tasks = await manager.taskList(swarm.id);
  assert.ok(tasks.every((task) => task.state === 'waiting_for_provider' && task.assignedAgentId));
});

test('swarm readiness honors priority after prerequisites complete', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-priority-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const manager = new NativeSwarmManager({ dataDir, subagents: fakeSubagents() });
  const swarm = await manager.create({ objective: 'Prioritize work', root: dataDir });
  await manager.plan(swarm.id, [
    { key: 'low', prompt: 'low', priority: 'LOW' },
    { key: 'critical', prompt: 'critical', priority: 'CRITICAL' },
  ]);
  const graph = manager._graph(manager.swarms.get(swarm.id));
  assert.deepEqual(graph.ready().map((task) => task.key), ['critical', 'low']);
});

test('scheduler reserves declared CPU, RAM, GPU, and process capacity', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-resources-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const subagents = fakeSubagents();
  subagents.status = () => ({ state: 'running' });
  let submissions = 0;
  const submit = subagents.submit.bind(subagents);
  subagents.submit = (...args) => { submissions++; return submit(...args); };
  const manager = new NativeSwarmManager({ dataDir, subagents, pollIntervalMs: 10,
    captureResources: async () => ({ cpu: 2, ram_mb: 1024, vram_mb: 0, processes: 1 }) });
  const swarm = await manager.create({ objective: 'Respect local resources', root: dataDir });
  await manager.plan(swarm.id, [
    { key: 'a', prompt: 'small task', resourceRequirements: { cpu: 1, ram_mb: 768, processes: 1 } },
    { key: 'b', prompt: 'competes for memory', resourceRequirements: { cpu: 1, ram_mb: 768, processes: 1 } },
    { key: 'gpu', prompt: 'needs GPU', resourceRequirements: { cpu: 1, ram_mb: 128, vram_mb: 512 } },
  ]);
  await manager.start(swarm.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(submissions, 1, 'only the first task fits within the reserved RAM budget');
  const status = await manager.status(swarm.id);
  assert.equal(status.resources.ram_mb, 1024);
  assert.equal(status.resources.vram_mb, 0);
  const tasks = await manager.taskList(swarm.id);
  assert.equal(tasks.filter((task) => task.state === 'pending').length, 2);
  await manager.cancel(swarm.id);
});

test('scheduler reports permanently impossible resource demands and clears the blocker when capacity returns', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-starvation-'));
  let manager;
  let swarm;
  t.after(async () => {
    if (manager && swarm) await manager.cancel(swarm.id).catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  let available = { cpu: 4, ram_mb: 1024, vram_mb: 0, processes: 8 };
  const subagents = fakeSubagents();
  manager = new NativeSwarmManager({ dataDir, subagents, maxConcurrency: 4, pollIntervalMs: 10,
    captureResources: async () => available });
  swarm = await manager.create({ objective: 'Report impossible capacity demands', root: dataDir, maxConcurrency: 4 });
  await manager.plan(swarm.id, [{ key: 'gpu-build', prompt: 'Run a GPU build', resourceRequirements: { cpu: 1, ram_mb: 512, vram_mb: 256, processes: 1 } }]);
  await manager.start(swarm.id);
  const waiting = await manager.status(swarm.id);
  assert.equal(waiting.resourceStarvedTasks.length, 1);
  assert.match(waiting.resourceStarvedTasks[0].reason, /vram_mb: needs 256, available 0/);
  assert.equal((await manager.taskStatus(swarm.id, 'gpu-build')).assignedAgentId, null);
  available = { cpu: 4, ram_mb: 2048, vram_mb: 512, processes: 8 };
  await manager._pump(swarm.id);
  assert.deepEqual((await manager.status(swarm.id)).resourceStarvedTasks, []);
  assert.ok((await manager.taskStatus(swarm.id, 'gpu-build')).assignedAgentId);
  await manager.cancel(swarm.id);
});

test('write swarms require review and integration before reporting success', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-review-gate-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const subagents = fakeSubagents();
  subagents.submit = () => ({ agents: [{ id: 'write-agent' }] });
  subagents.status = () => ({ state: 'completed' });
  subagents.result = () => ({ state: 'completed', result: { status: 'completed', summary: 'Updated source', changes: { files: [{ path: 'src/a.js' }] } } });
  const manager = new NativeSwarmManager({ dataDir, subagents, pollIntervalMs: 10 });
  const swarm = await manager.create({ objective: 'Review code before declaring success', root: dataDir });
  await manager.plan(swarm.id, [{ key: 'change', prompt: 'Update source', mode: 'write', readPaths: ['.'], writePaths: ['src'] }]);
  await manager.start(swarm.id);
  assert.equal((await manager.wait(swarm.id, 1000)).status, 'review_required');
  const review = await manager.review(swarm.id);
  assert.equal(review.reports[0].reviewToken, 'a'.repeat(64));
  const integrated = await manager.integrate(swarm.id, 'change', ['src/a.js'], review.reports[0].reviewToken);
  assert.deepEqual(integrated.applied, ['src/a.js']);
  assert.equal((await manager.status(swarm.id)).status, 'completed');
});

test('global concurrency is shared fairly across persisted swarms', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-global-cap-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const subagents = fakeSubagents();
  subagents.status = () => ({ state: 'running' });
  const manager = new NativeSwarmManager({ dataDir, subagents, maxConcurrency: 1, pollIntervalMs: 10 });
  const first = await manager.create({ objective: 'First swarm', root: dataDir, maxConcurrency: 4 });
  const second = await manager.create({ objective: 'Second swarm', root: dataDir, maxConcurrency: 4 });
  await manager.plan(first.id, [{ key: 'first', prompt: 'first task' }]);
  await manager.plan(second.id, [{ key: 'second', prompt: 'second task' }]);
  await manager.start(first.id);
  await manager.start(second.id);
  assert.equal((await manager.status(first.id)).schedulerConcurrency, 1);
  assert.ok((await manager.taskStatus(first.id, 'first')).assignedAgentId);
  assert.equal((await manager.taskStatus(second.id, 'second')).assignedAgentId, null);
  await manager.cancel(first.id);
  await manager.cancel(second.id);
});

test('persisted agent wait graph detects, escalates, and resolves cross-agent deadlocks', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-deadlock-'));
  let manager;
  let swarm;
  t.after(async () => {
    if (manager && swarm) await manager.cancel(swarm.id).catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const subagents = fakeSubagents();
  let nextId = 0;
  subagents.submit = () => {
    const id = `wait-agent-${++nextId}`;
    subagents.records.set(id, { state: 'running' });
    return { agents: [{ id }] };
  };
  subagents.status = () => ({ state: 'running' });
  manager = new NativeSwarmManager({ dataDir, subagents, maxConcurrency: 4, pollIntervalMs: 10,
    captureResources: async () => ({ cpu: 8, ram_mb: 8192, vram_mb: 0, processes: 128 }) });
  swarm = await manager.create({ objective: 'Detect coordination deadlocks', root: dataDir, maxConcurrency: 4 });
  await manager.plan(swarm.id, [
    { key: 'agent-a', prompt: 'Inspect A', readPaths: ['.'] },
    { key: 'agent-b', prompt: 'Inspect B', readPaths: ['.'] },
  ]);
  await manager.start(swarm.id);
  for (let tries = 0; tries < 50; tries++) {
    const tasks = await manager.taskList(swarm.id);
    if (tasks.every((task) => task.state === 'running')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const tasks = await manager.taskList(swarm.id);
  const first = tasks.find((task) => task.key === 'agent-a');
  const second = tasks.find((task) => task.key === 'agent-b');
  assert.equal(first.state, 'running');
  assert.equal(second.state, 'running');
  const firstTools = manager.createAgentTools({ swarmId: swarm.id, taskId: first.id, agentId: first.assignedAgentId });
  const secondTools = manager.createAgentTools({ swarmId: swarm.id, taskId: second.id, agentId: second.assignedAgentId });
  const edge = await firstTools.execute('agent_wait_for', { targetAgentId: second.assignedAgentId, reason: 'Need its API decision' });
  assert.equal(edge.detected, false);
  const cycle = await secondTools.execute('agent_wait_for', { targetAgentId: first.assignedAgentId, reason: 'Need its implementation first' });
  assert.equal(cycle.detected, true);
  assert.equal(cycle.escalated, true);
  assert.deepEqual(cycle.deadlock.cycleAgentIds, [second.assignedAgentId, first.assignedAgentId, second.assignedAgentId]);
  assert.equal((await manager.waitGraph(swarm.id)).activeDeadlocks, 1);
  const cleared = await firstTools.execute('agent_wait_clear', { targetAgentId: null });
  assert.equal(cleared.cleared, 1);
  const graph = await manager.waitGraph(swarm.id);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.activeDeadlocks, 0);
  assert.equal(graph.deadlocks[0].resolved, true);
  assert.ok((await manager.events(swarm.id)).events.some((event) => event.type === 'deadlock.detected'));
  await manager.cancel(swarm.id);
  const restarted = new NativeSwarmManager({ dataDir, subagents });
  const recovered = await restarted.waitGraph(swarm.id);
  assert.equal(recovered.deadlocks.length, 1);
  assert.equal(recovered.deadlocks[0].resolved, true);
});
