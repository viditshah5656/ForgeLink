import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewerBridge } from './viewer-bridge.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('viewer bridge accepts a handshake slower than the former two-second limit', async () => {
  let connections = 0;
  const bridge = createViewerBridge({
    createApp: () => ({ async connect() { connections++; await delay(30); }, close() {} }),
    timeoutMs: 100,
  });
  const [a, b] = await Promise.all([bridge.connect(), bridge.connect()]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(connections, 1);
  bridge.dispose();
});

test('hung or rejected handshakes retire the old app and permit one retry', async () => {
  let firstResolve;
  let closed = 0;
  let created = 0;
  let connected = 0;
  const bridge = createViewerBridge({
    createApp: () => {
      const number = ++created;
      return { connect: () => number === 1 ? new Promise((resolve) => { firstResolve = resolve; }) : Promise.resolve(), close: () => { closed++; } };
    },
    timeoutMs: 15,
    onConnected: () => { connected++; },
  });
  assert.equal(await bridge.connect(), false);
  assert.equal(closed, 1);
  assert.equal(await bridge.connect(), true);
  firstResolve();
  await delay(0);
  assert.equal(connected, 1);
  assert.equal(created, 2);
  bridge.dispose();
});

test('rejection allows retry and disposal closes the active app', async () => {
  let created = 0;
  let closed = 0;
  const bridge = createViewerBridge({
    createApp: () => ({ connect: () => ++created === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(), close: () => { closed++; } }),
    timeoutMs: 100,
  });
  assert.equal(await bridge.connect(), false);
  assert.equal(await bridge.connect(), true);
  bridge.dispose();
  assert.equal(closed, 2);
});
