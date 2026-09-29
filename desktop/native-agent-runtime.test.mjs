import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNativeAgent } from './native-agent-runtime.mjs';

const tool = { name: 'fs_read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };

function registry(responses) {
  return { async resolve() { return { status: 'available', provider: {
    id: 'fake-local', async generate() { return responses.shift(); },
  }, models: [{ id: 'fixture-model' }] }; } };
}

test('native runtime executes only registered ForgeLink tools and returns structured results', async () => {
  const executions = [];
  const responses = [
    { text: '', toolCalls: [
      { name: 'fs_read', arguments: { path: 'README.md' } },
      { name: 'run_shell', arguments: { command: 'whoami' } },
    ] },
    { text: 'Inspected the requested file.', toolCalls: [], usage: { promptTokens: 10 } },
  ];
  const result = await runNativeAgent({ providerRegistry: registry(responses), prompt: 'Inspect the project',
    tools: [tool], executeTool: async (call) => { executions.push(call); return { content: 'safe' }; } });
  assert.equal(result.status, 'completed');
  assert.equal(result.provider, 'fake-local');
  assert.equal(executions.length, 1);
  assert.equal(executions[0].name, 'fs_read');
  assert.equal(result.tool_calls[1].status, 'rejected');
  assert.deepEqual(result.usage, { promptTokens: 10 });
});

test('native runtime surfaces unavailable inference as waiting_for_provider', async () => {
  const result = await runNativeAgent({ providerRegistry: { async resolve() {
    return { status: 'waiting_for_provider', provider: null, reason: 'The configured provider is offline' };
  } }, prompt: 'Analyze this project', tools: [], executeTool: async () => {} });
  assert.equal(result.status, 'waiting_for_provider');
  assert.deepEqual(result.blockers, ['The configured provider is offline']);
});

test('native runtime stops when the caller cancels', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runNativeAgent({ providerRegistry: registry([]), prompt: 'Cancel me', tools: [],
    executeTool: async () => {}, signal: controller.signal });
  assert.equal(result.status, 'cancelled');
});
