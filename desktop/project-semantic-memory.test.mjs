import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectSemanticMemory } from './project-semantic-memory.mjs';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-memory-'));
  const dataDir = path.join(dir, 'data');
  const a = path.join(dir, 'alpha');
  const b = path.join(dir, 'other', 'alpha');
  await fs.mkdir(a, { recursive: true });
  await fs.mkdir(b, { recursive: true });
  return { dir, dataDir, a, b, memory: new ProjectSemanticMemory({ dataDir }) };
}

test('project identity isolates repositories with the same display name', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.dir,{recursive:true,force:true}));
  const one = await f.memory.identifyProject(f.a);
  const two = await f.memory.identifyProject(f.b);
  assert.equal(one.name, two.name);
  assert.notEqual(one.projectId, two.projectId);
});

test('verified memory persists, reloads and updates equivalent records', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.dir,{recursive:true,force:true}));
  const source = { protocolId: 'protocol-1', transactionId: 'transaction-1', status: 'committed' };
  const entry = { kind:'architecture', title:'Runtime ownership', summary:'The desktop runtime owns local orchestration while ChatGPT remains the reasoning host.', tags:['runtime'], paths:['desktop/main.mjs'], symbols:['Runtime'] };
  const first = await f.memory.promote({ projectPath:f.a, entries:[entry], source });
  assert.equal(first.totalEntries, 1);
  const second = await f.memory.promote({ projectPath:f.a, entries:[{...entry, summary:'The desktop runtime owns orchestration and the MCP server exposes bounded tools.'}], source });
  assert.equal(second.totalEntries, 1);
  assert.equal(second.promoted[0].revision, 2);
  const reloaded = new ProjectSemanticMemory({ dataDir:f.dataDir });
  const status = await reloaded.status(f.a);
  assert.equal(status.entries, 1);
});

test('context ranking favors verified path and symbol matches and remains bounded', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.dir,{recursive:true,force:true}));
  await f.memory.promote({ projectPath:f.a, source:{status:'verified'}, entries:[
    {kind:'ownership',title:'Artifact UI owner',summary:'Artifact presentation behavior is owned by the artifact UI client.',paths:['desktop/artifact-ui-client.js'],symbols:['refreshLinkedWorkflow'],tags:['artifact'],confidence:'verified'},
    {kind:'follow_up',title:'Unrelated polish',summary:'Consider spacing polish in another surface.',paths:['web/index.html'],symbols:[],tags:['web'],confidence:'inferred'},
  ]});
  const result = await f.memory.context({ projectPath:f.a, query:'approval artifact workflow', paths:['desktop/artifact-ui-client.js'], symbols:['refreshLinkedWorkflow'], limit:1 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].title, 'Artifact UI owner');
  assert.match(result.rule, /Current repository evidence overrides/i);
});

test('rolled-back, preview-only, secret-like and oversized source dumps are rejected', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.dir,{recursive:true,force:true}));
  await assert.rejects(() => f.memory.promote({
    projectPath:f.a, source:{status:'rolled_back'}, entries:[{kind:'transaction',title:'Bad',summary:'Should not persist'}],
  }), /committed or verified/i);
  await assert.rejects(() => f.memory.promote({
    projectPath:f.a, source:{status:'committed'}, entries:[{kind:'decision',title:'Secret',summary:'api_key=supersecretvalue'}],
  }), /credential/i);
  await assert.rejects(() => f.memory.promote({
    projectPath:f.a, source:{status:'committed'}, entries:[{kind:'decision',title:'Dump',summary:'x'.repeat(4001)}],
  }), /at most 4000/i);
});
