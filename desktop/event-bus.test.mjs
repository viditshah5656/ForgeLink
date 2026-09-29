import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from './event-bus.mjs';

test('event history is bounded, filtered, and respects current visibility', () => {
  const bus = new EventBus({ maxEvents: 3 });
  bus.publish({ type: 'job.started', path: 'approved', jobId: 'job-1' });
  bus.publish({ type: 'file.modified', path: 'private' });
  bus.publish({ type: 'file.created', path: 'approved' });
  bus.publish({ type: 'job.completed', path: 'approved', jobId: 'job-1' });

  const history = bus.history({ afterId: 1, types: ['file.*'], visible: (event) => event.path === 'approved' });
  assert.deepEqual(history.events.map((event) => event.type), ['file.created']);
  assert.equal(history.oldestId, 2);
  assert.equal(history.latestId, 4);
  assert.equal(history.truncatedBeforeId, false);
  assert.equal(bus.history({ afterId: 0, limit: 2 }).events.length, 2);
  assert.equal(bus.history({ afterId: 1 }).truncatedBeforeId, false);
  assert.equal(bus.history({ afterId: 0 }).oldestId, 2);
});

test('deadlock event history includes the cycle needed for supervisor escalation', () => {
  const bus = new EventBus();
  bus.publish({ type: 'swarm.deadlock.detected', operationId: 'swarm-1', deadlockId: 'deadlock-1', cycleAgentIds: ['agent-a', 'agent-b', 'agent-a'] });
  const [event] = bus.history().events;
  assert.equal(event.operationId, 'swarm-1');
  assert.equal(event.deadlockId, 'deadlock-1');
  assert.deepEqual(event.cycleAgentIds, ['agent-a', 'agent-b', 'agent-a']);
});

test('subscriptions advance over hidden events and wake for matching events', async () => {
  const bus = new EventBus();
  const { subscriptionId } = bus.subscribe({ types: ['file.*'] });
  const pending = bus.next(subscriptionId, { timeoutMs: 1000, visible: (event) => event.path === 'approved' });
  bus.publish({ type: 'job.completed', path: 'approved' });
  bus.publish({ type: 'file.modified', path: 'private' });
  bus.publish({ type: 'file.created', path: 'approved' });
  const result = await pending;
  assert.deepEqual(result.events.map((event) => event.type), ['file.created']);
  assert.equal(result.cursor, 3);
  assert.deepEqual((await bus.next(subscriptionId, { timeoutMs: 0 })).events, []);
  assert.equal(bus.list().subscriptions.length, 1);
  assert.equal(bus.unsubscribe(subscriptionId).unsubscribed, true);
  await assert.rejects(bus.next(subscriptionId, { timeoutMs: 0 }), /not found/);
});

test('only one long poll uses a cursor and unsubscribe releases its listener', async () => {
  const bus = new EventBus();
  const { subscriptionId } = bus.subscribe();
  const pending = bus.next(subscriptionId, { timeoutMs: 1000 });
  await assert.rejects(bus.next(subscriptionId, { timeoutMs: 1000 }), /already waiting/);
  assert.equal(bus.unsubscribe(subscriptionId).unsubscribed, true);
  assert.equal((await pending).unsubscribed, true);
  assert.equal(bus.listeners.size, 0);
});
