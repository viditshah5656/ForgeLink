import test from 'node:test';
import assert from 'node:assert/strict';
import { runWebSubagent } from './web-subagent-runtime.mjs';

const weatherTool = {
  type: 'function',
  name: 'read_weather',
  description: 'Read the forecast',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  strict: true,
};

function apiResponse(output, usage = { input_tokens: 9, output_tokens: 5, total_tokens: 14 }, status = 'completed') {
  return { ok: true, status: 200, json: async () => ({ output, usage, status }) };
}

function message(text) {
  return { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] };
}

function options(extra = {}) {
  return { apiKey: 'secret-test-key', model: 'test-model', prompt: 'Do the assigned task', ...extra };
}

test('one worker makes one stateless request and returns text and token usage', async () => {
  const calls = [];
  const result = await runWebSubagent(options({
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return apiResponse([message('Done')]);
    },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'Done');
  assert.equal(result.turns, 1);
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 5, totalTokens: 14 });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-test-key');
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.tool_choice, 'none');
  assert.equal(calls[0].body.max_output_tokens, 1_500);
  assert.deepEqual(calls[0].body.input, [{ role: 'user', content: 'Do the assigned task' }]);
  assert.equal(JSON.stringify(result).includes('secret-test-key'), false);
});

test('tool loop replays full response output and call result without server state', async () => {
  const bodies = [];
  const executions = [];
  const reasoning = { id: 'rs_1', type: 'reasoning', encrypted_content: 'opaque' };
  const functionCall = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_weather', arguments: '{"city":"Paris"}' };
  const responses = [
    apiResponse([reasoning, functionCall]),
    apiResponse([message('Paris is sunny')], { input_tokens: 12, output_tokens: 6, total_tokens: 18 }),
  ];
  const result = await runWebSubagent(options({
    tools: [weatherTool],
    executeTool: async (call) => {
      executions.push(call);
      return { condition: 'sunny' };
    },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return responses.shift();
    },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'Paris is sunny');
  assert.equal(result.turns, 2);
  assert.deepEqual(result.usage, { inputTokens: 21, outputTokens: 11, totalTokens: 32 });
  assert.deepEqual(result.toolCalls, [{ name: 'read_weather', callId: 'call_1', status: 'completed' }]);
  assert.deepEqual(executions[0].arguments, { city: 'Paris' });
  assert.equal(bodies[0].parallel_tool_calls, false);
  assert.equal(bodies[1].store, false);
  assert.deepEqual(bodies[1].input.slice(1, 3), [reasoning, functionCall]);
  assert.deepEqual(bodies[1].input[3], { type: 'function_call_output', call_id: 'call_1', output: '{"condition":"sunny"}' });
});

test('unexpected tools are rejected without executing them', async () => {
  let executed = false;
  const bodies = [];
  const responses = [
    apiResponse([{ type: 'function_call', call_id: 'call_bad', name: 'run_shell', arguments: '{}' }]),
    apiResponse([message('Cannot do that')]),
  ];
  const result = await runWebSubagent(options({
    tools: [weatherTool],
    executeTool: async () => { executed = true; },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return responses.shift();
    },
  }));
  assert.equal(executed, false);
  assert.equal(result.toolCalls[0].status, 'rejected');
  assert.match(bodies[1].input.at(-1).output, /not allowed/);
});

test('turn limit stops before a last-turn tool call executes', async () => {
  let executed = false;
  const result = await runWebSubagent(options({
    tools: [weatherTool],
    maxTurns: 1,
    executeTool: async () => { executed = true; },
    fetchImpl: async () => apiResponse([{ type: 'function_call', call_id: 'call_1', name: 'read_weather', arguments: '{}' }]),
  }));
  assert.equal(result.status, 'incomplete');
  assert.equal(result.turns, 1);
  assert.equal(executed, false);
});

test('abort prevents an API request', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  await assert.rejects(runWebSubagent(options({
    signal: controller.signal,
    fetchImpl: async () => { fetched = true; },
  })), { name: 'AbortError' });
  assert.equal(fetched, false);
});

test('transport and HTTP errors never include credential or server response body', async () => {
  await assert.rejects(runWebSubagent(options({
    fetchImpl: async () => { throw new Error('secret-test-key in proxy diagnostics'); },
  })), (error) => !error.message.includes('secret-test-key') && /network error/.test(error.message));
  await assert.rejects(runWebSubagent(options({
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'secret-test-key' }),
  })), (error) => !error.message.includes('secret-test-key') && /401/.test(error.message));
});

test('strict definitions and official endpoint are enforced', async () => {
  await assert.rejects(runWebSubagent(options({ tools: [{ type: 'web_search' }] })), /function tools/);
  await assert.rejects(runWebSubagent(options({ tools: [weatherTool] })), /executeTool/);
  await assert.rejects(runWebSubagent(options({ baseUrl: 'https://example.com/v1' })), /official OpenAI/);
});

test('transient API rate limits are retried without consuming an agent turn', async () => {
  let requests = 0;
  const result = await runWebSubagent(options({
    fetchImpl: async () => {
      requests++;
      return requests === 1
        ? { ok: false, status: 429, headers: { get: () => null }, body: { cancel: async () => {} } }
        : apiResponse([message('Recovered')]);
    },
  }));
  assert.equal(requests, 2);
  assert.equal(result.turns, 1);
  assert.equal(result.output, 'Recovered');
});

test('total input token cap prevents further tool calls', async () => {
  let executed = false;
  const result = await runWebSubagent(options({
    tools: [weatherTool], maxTotalInputTokens: 10,
    executeTool: async () => { executed = true; },
    fetchImpl: async () => apiResponse([{ type: 'function_call', call_id: 'call_1', name: 'read_weather', arguments: '{}' }],
      { input_tokens: 10, output_tokens: 2, total_tokens: 12 }),
  }));
  assert.equal(result.status, 'incomplete');
  assert.equal(executed, false);
  assert.equal(result.usage.inputTokens, 10);
});
