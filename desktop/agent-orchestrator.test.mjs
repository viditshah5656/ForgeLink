import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentOrchestrator, AGENT_ORCHESTRATOR_MAX_CONCURRENCY } from './agent-orchestrator.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function tick() { await new Promise((resolve) => setImmediate(resolve)); }

test('supports configurable parallel work', async () => {
  const gates = [];
  let active = 0;
  let peak = 0;
  const orchestrator = new AgentOrchestrator({
    concurrency: 12,
    execute: async ({ index }) => {
      active++;
      peak = Math.max(peak, active);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      active--;
      return { index };
    },
  });
  const batch = orchestrator.submitBatch(Array.from({ length: 15 }, (_, index) => ({ workUnit: { index } })));
  await tick();
  assert.equal(peak, 12);
  assert.equal(orchestrator.stats().queued, 3);
  gates.slice(0, 12).forEach((gate) => gate.resolve());
  await tick();
  assert.equal(peak, 12);
  assert.equal(gates.length, 15);
  gates.slice(12).forEach((gate) => gate.resolve());
  const finished = await Promise.all(batch.map(({ id }) => orchestrator.wait(id)));
  assert.deepEqual(finished.map((entry) => entry.result.index).sort((a, b) => a - b), Array.from({ length: 15 }, (_, n) => n));
  assert.equal(orchestrator.stats().occupied, 0);
  assert.equal(AGENT_ORCHESTRATOR_MAX_CONCURRENCY, 64);
  assert.throws(() => new AgentOrchestrator({ concurrency: 65, execute() {} }), /concurrency/);
});

test('worker heartbeats renew inactivity timeouts while preserving task completion', async () => {
  const gate = deferred();
  const orchestrator = new AgentOrchestrator({ execute: async () => { await gate.promise; return { status: 'done' }; } });
  const [worker] = orchestrator.submitBatch([{ timeoutMs: 100, workUnit: { name: 'heartbeat' } }]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const renewed = orchestrator.heartbeat(worker.id);
  assert.equal(renewed.state, 'running');
  assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.now());
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(orchestrator.status(worker.id).state, 'running');
  orchestrator.heartbeat(worker.id);
  gate.resolve();
  assert.equal((await orchestrator.wait(worker.id, 1000)).state, 'completed');
});

test('round-robin scheduling prevents a group from monopolizing free slots', async () => {
  const started = [];
  const gates = new Map();
  const orchestrator = new AgentOrchestrator({
    concurrency: 2,
    execute: async ({ name }) => {
      started.push(name);
      const gate = deferred();
      gates.set(name, gate);
      await gate.promise;
      return name;
    },
  });
  const items = orchestrator.submitBatch([
    ...['a1', 'a2', 'a3', 'a4'].map((name) => ({ groupId: 'A', workUnit: { name } })),
    ...['b1', 'b2'].map((name) => ({ groupId: 'B', workUnit: { name } })),
  ]);
  await tick();
  assert.deepEqual(started, ['a1', 'b1']);
  gates.get('a1').resolve();
  gates.get('b1').resolve();
  await tick();
  assert.deepEqual(started, ['a1', 'b1', 'a2', 'b2']);
  gates.get('a2').resolve();
  gates.get('b2').resolve();
  await tick();
  gates.get('a3').resolve();
  gates.get('a4').resolve();
  assert.equal((await Promise.all(items.map(({ id }) => orchestrator.wait(id)))).every((item) => item.state === 'completed'), true);
});

test('batch admission is atomic and a queued cancellation never executes', async () => {
  const gate = deferred();
  const ran = [];
  const orchestrator = new AgentOrchestrator({
    concurrency: 1, maxQueued: 2,
    execute: async ({ name }) => { ran.push(name); if (name === 'first') await gate.promise; return name; },
  });
  const [first, second] = orchestrator.submitBatch([
    { workUnit: { name: 'first' } }, { workUnit: { name: 'second' } },
  ]);
  assert.throws(() => orchestrator.submitBatch([
    { workUnit: { name: 'third' } }, { workUnit: undefined },
  ]), /workUnit/);
  assert.equal(orchestrator.stats().records, 2);
  await tick();
  orchestrator.cancel(second.id);
  gate.resolve();
  assert.equal((await orchestrator.wait(second.id)).state, 'cancelled');
  assert.equal((await orchestrator.wait(first.id)).state, 'completed');
  assert.deepEqual(ran, ['first']);
});

test('running cancellation aborts, returns promptly, and retains the slot until cleanup', async () => {
  const gate = deferred();
  let signal;
  let secondStarted = false;
  const orchestrator = new AgentOrchestrator({
    concurrency: 1,
    execute: async ({ name }, currentSignal) => {
      if (name === 'first') { signal = currentSignal; await gate.promise; }
      else secondStarted = true;
      return name;
    },
  });
  const [first, second] = orchestrator.submitBatch([
    { workUnit: { name: 'first' } }, { workUnit: { name: 'second' } },
  ]);
  await tick();
  assert.equal(orchestrator.cancel(first.id).state, 'cancelled');
  assert.equal(signal.aborted, true);
  assert.equal((await orchestrator.wait(first.id)).state, 'cancelled');
  await tick();
  assert.equal(orchestrator.stats().occupied, 1);
  assert.equal(secondStarted, false);
  gate.resolve();
  assert.equal((await orchestrator.wait(second.id)).result, 'second');
});

test('timeout isolates an uncooperative worker and does not oversubscribe', async () => {
  const gate = deferred();
  let secondStarted = false;
  let signal;
  const orchestrator = new AgentOrchestrator({
    concurrency: 1,
    execute: async ({ name }, currentSignal) => {
      if (name === 'slow') { signal = currentSignal; await gate.promise; }
      else secondStarted = true;
      return name;
    },
  });
  const [slow, next] = orchestrator.submitBatch([
    { workUnit: { name: 'slow' }, timeoutMs: 20 },
    { workUnit: { name: 'next' } },
  ]);
  assert.equal((await orchestrator.wait(slow.id, 500)).state, 'timed_out');
  assert.equal(signal.aborted, true);
  assert.equal(orchestrator.status(slow.id).workerActive, true);
  assert.equal(secondStarted, false);
  gate.resolve();
  assert.equal((await orchestrator.wait(next.id)).state, 'completed');
});

test('failed work does not affect peers, and inputs, outputs, and events are copied', async () => {
  const events = [];
  const payload = { nested: { value: 1 } };
  const orchestrator = new AgentOrchestrator({
    concurrency: 2,
    onEvent: (event) => { events.push(event); throw new Error('observer failure'); },
    execute: (unit) => {
      if (unit.fail) throw new Error('planned failure');
      unit.nested.value = 9;
      return { nested: unit.nested };
    },
  });
  const [okay, failure] = orchestrator.submitBatch([
    { workUnit: payload, metadata: { owner: 'web' } },
    { workUnit: { fail: true } },
  ]);
  payload.nested.value = 3;
  const completed = await orchestrator.wait(okay.id);
  const failed = await orchestrator.wait(failure.id);
  assert.equal(completed.result.nested.value, 9);
  assert.equal(payload.nested.value, 3);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error.message, /planned failure/);
  completed.result.nested.value = 99;
  assert.equal(orchestrator.result(okay.id).result.nested.value, 9);
  assert.ok(events.some((event) => event.type === 'completed'));
  assert.ok(orchestrator.history().length >= 4);
});

test('group cancellation and close reject future submissions', async () => {
  const gate = deferred();
  const orchestrator = new AgentOrchestrator({ concurrency: 1, execute: () => gate.promise });
  const [one, two, three] = orchestrator.submitBatch([
    { groupId: 'g', workUnit: 1 }, { groupId: 'g', workUnit: 2 }, { groupId: 'other', workUnit: 3 },
  ]);
  await tick();
  assert.equal(orchestrator.cancelGroup('g'), 2);
  assert.equal(orchestrator.status(one.id).state, 'cancelled');
  assert.equal(orchestrator.status(two.id).state, 'cancelled');
  orchestrator.close();
  assert.equal(orchestrator.status(three.id).state, 'cancelled');
  assert.throws(() => orchestrator.submit({ workUnit: 4 }), /closed/);
  gate.resolve();
});

test('a lifecycle observer can close during start without invoking the executor', async () => {
  let orchestrator;
  let calls = 0;
  orchestrator = new AgentOrchestrator({
    execute: () => { calls++; return null; },
    onEvent: (event) => { if (event.type === 'started') orchestrator.close(); },
  });
  const unit = orchestrator.submit({ workUnit: { task: 'read' } });
  await tick();
  assert.equal(calls, 0);
  assert.equal(orchestrator.status(unit.id).state, 'cancelled');
  assert.equal(orchestrator.stats().occupied, 0);
});

test('concurrency can be raised while work is queued, subject to the hard limit', async () => {
  const gates = [];
  const orchestrator = new AgentOrchestrator({
    concurrency: 1,
    execute: () => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  });
  const units = orchestrator.submitBatch(Array.from({ length: 3 }, (_, n) => ({ workUnit: n })));
  await tick();
  assert.equal(gates.length, 1);
  orchestrator.setConcurrency(3);
  await tick();
  assert.equal(gates.length, 3);
  assert.throws(() => orchestrator.setConcurrency(65), /concurrency/);
  gates.forEach((gate) => gate.resolve('done'));
  assert.equal((await Promise.all(units.map(({ id }) => orchestrator.wait(id)))).every((unit) => unit.state === 'completed'), true);
});

test('provider-waiting work releases its slot and can be requeued later', async () => {
  let providerReady = false;
  const orchestrator = new AgentOrchestrator({ concurrency: 1, execute: async () => {
    if (!providerReady) return { __orchestratorState: 'waiting_for_provider', reason: 'start the configured provider', result: { status: 'waiting_for_provider' } };
    return { status: 'completed' };
  } });
  const unit = orchestrator.submit({ workUnit: { task: 'model' } });
  const waiting = await orchestrator.wait(unit.id, 1000);
  assert.equal(waiting.state, 'waiting_for_provider');
  assert.equal(orchestrator.stats().occupied, 0);
  assert.equal(orchestrator.stats().states.waiting_for_provider, 1);
  providerReady = true;
  orchestrator.resume(unit.id);
  assert.equal((await orchestrator.wait(unit.id, 1000)).state, 'completed');
});
