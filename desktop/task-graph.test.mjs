import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskGraph } from './task-graph.mjs';

const task = (key, dependencies = [], priority = 'NORMAL') => ({ key, title: key, description: `Task ${key}`, dependencies, priority });

test('validates dependencies, rejects unknown tasks and cycles', () => {
  assert.throws(() => new TaskGraph([task('a', ['missing'])]), /unknown dependency/);
  assert.throws(() => new TaskGraph([task('a', ['b']), task('b', ['a'])]), /cycle/);
  assert.throws(() => new TaskGraph([task('a'), task('a')]), /Duplicate task key/);
});

test('task graph releases dependents only after successful prerequisite completion', () => {
  const graph = new TaskGraph([task('foundation'), task('api', ['foundation'], 'HIGH'), task('ui', ['foundation']), task('review', ['api', 'ui'])]);
  assert.deepEqual(graph.ready().map((item) => item.key), ['foundation']);
  const foundation = graph.getByKey('foundation');
  graph.transition(foundation.id, 'queued');
  graph.transition(foundation.id, 'running');
  graph.transition(foundation.id, 'completed');
  assert.deepEqual(graph.ready().map((item) => item.key), ['api', 'ui']);
  graph.transition(graph.getByKey('api').id, 'queued');
  graph.transition(graph.getByKey('api').id, 'running');
  graph.transition(graph.getByKey('api').id, 'failed', { error: 'fixture failure' });
  assert.deepEqual(graph.blockedByFailure().map((item) => item.key), ['review']);
  assert.equal(graph.summary().counts.failed, 1);
});

test('transitions reject illegal lifecycle changes and protected identity mutation', () => {
  const graph = new TaskGraph([task('build')]);
  const build = graph.getByKey('build');
  assert.throws(() => graph.transition(build.id, 'completed'), /Invalid task transition/);
  assert.throws(() => graph.transition(build.id, 'queued', { key: 'other' }), /cannot be changed/);
});

test('adding a cyclic batch rolls back atomically', () => {
  const graph = new TaskGraph([task('root')]);
  assert.throws(() => graph.add([task('x', ['y']), task('y', ['x'])]), /cycle/);
  assert.deepEqual(graph.list().map((item) => item.key), ['root']);
});
