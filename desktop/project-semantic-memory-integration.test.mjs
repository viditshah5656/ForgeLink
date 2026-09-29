import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const privacy = fs.readFileSync(new URL('./package-privacy.cjs', import.meta.url), 'utf8');

test('server exposes lightweight project memory and durable engineering session tools', () => {
  for (const name of [
    'project_memory_context',
    'project_memory_status',
    'project_memory_update',
    'engineering_session_status',
    'engineering_session_timeline',
  ]) assert.match(server, new RegExp(name));
  assert.match(server, /ProjectSemanticMemory/);
  assert.match(server, /EngineeringSessionStore/);
  assert.match(server, /current repository evidence always overrides semantic memory/i);
  assert.match(server, /ChatGPT remains the reasoning engine/i);
  assert.match(server, /no local LLM, embedding model, vector database, GPU inference, or continuous background scanner/i);
  assert.match(server, /assertCompletable/);
  assert.match(server, /recoveryManager\.reconcileApplied\(transactionId\)/);
  assert.match(server, /engineeringSessions\.findByTransaction\(transactionId\)/);
});

test('semantic memory stays private from packaged builds', () => {
  assert.match(privacy, /project-memory/);
  assert.match(privacy, /engineering/);
});
