import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelProviderRegistry } from './model-providers.mjs';

test('provider registry starts empty and gives a clear MCP handoff diagnostic', async () => {
  const registry = new ModelProviderRegistry();
  assert.deepEqual(await registry.list(), []);
  const result = await registry.resolve('native');
  assert.equal(result.status, 'waiting_for_provider');
  assert.match(result.reason, /ChatGPT Web MCP handoff/);
});

test('provider registry accepts explicit future adapters without coupling to orchestration', async () => {
  const adapter = { id: 'example', async discover() { return { available: true, models: [{ id: 'model-a' }] }; },
    async generate() { return { text: 'ok' }; } };
  const registry = new ModelProviderRegistry({ providers: [adapter] });
  const resolved = await registry.resolve('example');
  assert.equal(resolved.provider, adapter);
  assert.deepEqual(resolved.models, [{ id: 'model-a' }]);
});
