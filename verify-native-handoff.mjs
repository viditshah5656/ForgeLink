import assert from 'node:assert/strict';
import path from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:24024';
const root = path.resolve(process.argv[3] || '.');
let sequence = 1;

async function mcp(method, params = {}) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: sequence++, method, params }) });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(JSON.stringify(payload.error || payload));
  return payload.result;
}
async function tool(name, args, { expectError = false } = {}) {
  const result = await mcp('tools/call', { name, arguments: args });
  if (expectError) { assert.equal(result.isError, true, `${name} should reject`); return result; }
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.content)}`);
  return JSON.parse(result.content[0].text);
}

const listed = (await mcp('tools/list')).tools.map((item) => item.name);
for (const name of ['subagent_batch', 'subagent_worker_native_spawn_packet', 'subagent_worker_spawn_child',
  'subagent_worker_tool', 'subagent_worker_checkpoint', 'subagent_worker_finish']) {
  assert.ok(listed.includes(name), `MCP tool missing: ${name}`);
}
const submitted = await tool('subagent_batch', { action: 'submit', agents: [{ root, prompt: 'Inspect README.md',
  readPaths: ['README.md'], mode: 'read' }] });
const parent = submitted.agents[0];
assert.match(parent.capabilityToken, /^[A-Za-z0-9_-]{43}$/);
let child;
try {
  let packet;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { packet = await tool('subagent_worker_native_spawn_packet', { workerId: parent.id, capabilityToken: parent.capabilityToken }); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  assert.equal(packet.workerId, parent.id);
  assert.equal(packet.capabilityToken, parent.capabilityToken);
  await tool('subagent_worker_tool', { workerId: parent.id, toolName: 'fs_read', arguments: { path: 'README.md', startLine: 1, endLine: 1 } }, { expectError: true });
  const read = await tool('subagent_worker_tool', { workerId: parent.id, capabilityToken: parent.capabilityToken,
    toolName: 'fs_read', arguments: { path: 'README.md', startLine: 1, endLine: 1 } });
  assert.ok(read.lines?.length);
  child = await tool('subagent_worker_spawn_child', { parentWorkerId: parent.id, capabilityToken: parent.capabilityToken,
    child: { objective: 'Check the first line', readPaths: ['README.md'], tools: ['fs_read'] } });
  assert.match(child.capabilityToken, /^[A-Za-z0-9_-]{43}$/);
  let childPacket;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { childPacket = await tool('subagent_worker_native_spawn_packet', { workerId: child.id, capabilityToken: child.capabilityToken }); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  assert.equal(childPacket.workerId, child.id);
  const childRead = await tool('subagent_worker_tool', { workerId: child.id, capabilityToken: child.capabilityToken,
    toolName: 'fs_read', arguments: { path: 'README.md', startLine: 1, endLine: 1 } });
  assert.ok(childRead.lines?.length);
  await tool('subagent_worker_tool', { workerId: child.id, capabilityToken: child.capabilityToken,
    toolName: 'fs_search', arguments: { path: '.', query: 'ForgeLink', maxResults: 1 } }, { expectError: true });
  await tool('subagent_worker_checkpoint', { workerId: child.id, capabilityToken: child.capabilityToken,
    progress: { completedWork: ['Read README first line'] } });
  await tool('subagent_worker_finish', { workerId: child.id, capabilityToken: child.capabilityToken,
    result: { summary: 'Child read its assigned file' } });
  await tool('subagent_worker_finish', { workerId: parent.id, capabilityToken: parent.capabilityToken,
    result: { summary: 'Parent completed scoped inspection' } });
  console.log(JSON.stringify({ ok: true, tools: listed.length, parentWorkerId: parent.id, childWorkerId: child.id,
    tokenlessCallRejected: true, ungrantedChildToolRejected: true }, null, 2));
} catch (error) {
  if (child) await tool('subagent_batch', { action: 'cancel', id: child.id }).catch(() => {});
  await tool('subagent_batch', { action: 'cancel', id: parent.id }).catch(() => {});
  throw error;
}
