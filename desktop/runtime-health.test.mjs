import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRuntimeState } from './runtime-health.mjs';

test('reports running only when backend and every enabled tunnel are healthy', () => {
  assert.equal(deriveRuntimeState({ backendHealthy: true, liveConnections: 2, enabledConnections: 2 }).state, 'running');
});
test('reports degraded when only some tunnels are healthy', () => {
  const state = deriveRuntimeState({ backendHealthy: true, liveConnections: 1, enabledConnections: 2 });
  assert.equal(state.state, 'degraded');
  assert.match(state.message, /1\/2/);
});
test('reports degraded when backend is healthy but no tunnel is ready', () => {
  assert.equal(deriveRuntimeState({ backendHealthy: true, liveConnections: 0, enabledConnections: 1 }).state, 'degraded');
});
test('reports degraded when a tunnel is reachable but backend is down', () => {
  assert.equal(deriveRuntimeState({ backendHealthy: false, liveConnections: 1, enabledConnections: 1 }).state, 'degraded');
});
test('reports stopped when neither side is healthy', () => {
  assert.equal(deriveRuntimeState({ backendHealthy: false, liveConnections: 0, enabledConnections: 1 }).state, 'stopped');
});
