import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineeringSessionStore } from './engineering-session.mjs';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-session-'));
  return { dir, store:new EngineeringSessionStore({dataDir:dir}) };
}

test('engineering sessions persist and recover links after restart', async (t)=>{
  const f=await fixture(); t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
  const started=await f.store.start({projectId:'p'.repeat(64),projectPath:f.dir,protocolId:'protocol-1',artifactId:'artifact-1',memorySnapshotIds:['mem-1']});
  await f.store.linkTransaction(started.id,{transactionId:'tx-1',state:'committed',paths:['a.js']});
  await f.store.recordVerification(started.id,{check:'unit tests',passed:true,evidence:'ok'});
  const reloaded=new EngineeringSessionStore({dataDir:f.dir});
  const recovered=await reloaded.findByProtocol('protocol-1');
  assert.equal(recovered.id,started.id);
  assert.deepEqual(recovered.transactionIds,['tx-1']);
  assert.deepEqual(recovered.memorySnapshotIds,['mem-1']);
});

test('timeline preserves high-signal state transitions in order', async (t)=>{
  const f=await fixture(); t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
  const started=await f.store.start({projectId:'p'.repeat(64),projectPath:f.dir,protocolId:'protocol-2',artifactId:'artifact-2'});
  await f.store.addMemorySnapshot(started.id,'mem-2');
  await f.store.linkTransaction(started.id,{transactionId:'tx-2',state:'previewed'});
  await f.store.linkTransaction(started.id,{transactionId:'tx-2',state:'rolled_back'});
  const timeline=await f.store.timeline(started.id);
  assert.deepEqual(timeline.events.map((e)=>e.kind),['session.started','memory.loaded','transaction.previewed','transaction.rolled_back']);
  assert.equal(timeline.events.at(-1).status,'warning');
  assert.equal((await f.store.status(started.id)).transactionStates['tx-2'],'rolled_back');
});

test('completion invariant requires passing verification, walkthrough and review for every transaction', async (t)=>{
  const f=await fixture(); t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
  const started=await f.store.start({projectId:'p'.repeat(64),projectPath:f.dir,protocolId:'protocol-3',artifactId:'artifact-3'});
  await f.store.linkTransaction(started.id,{transactionId:'tx-3',state:'committed'});
  await f.store.recordVerification(started.id,{check:'tests',passed:true});
  await f.store.markWalkthrough(started.id);
  await assert.rejects(()=>f.store.assertCompletable(started.id),/not presented/i);
  await f.store.recordReviewPresentation(started.id,{transactionId:'tx-3',reviewId:'review-3'});
  await f.store.recordReviewPresentation(started.id,{transactionId:'tx-3',reviewId:'review-3'});
  assert.equal((await f.store.timeline(started.id)).events.filter((event)=>event.kind==='review.presented').length,1);
  assert.equal(await f.store.assertCompletable(started.id),true);
});

test('protocol events normalize into restart-safe timeline state', async (t)=>{
  const f=await fixture(); t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
  const started=await f.store.start({projectId:'p'.repeat(64),projectPath:f.dir,protocolId:'protocol-4',artifactId:'artifact-4'});
  await f.store.recordProtocolEvent('protocol-4',{type:'execution.progress',phase:'execution',message:'Memory integration wired',status:'completed',milestoneKey:'m1'});
  await f.store.recordProtocolEvent('protocol-4',{type:'verification.result',phase:'verification',result:{id:'v1',check:'tests',passed:true,evidence:'ok',at:new Date().toISOString()}});
  await f.store.recordProtocolEvent('protocol-4',{type:'explanation',kind:'walkthrough.start',phase:'walkthrough',message:'walkthrough'});
  const state=await f.store.status(started.id);
  assert.equal(state.walkthroughReady,true);
  assert.equal(state.verification.length,1);
  assert.deepEqual((await f.store.timeline(started.id)).events.slice(-3).map((e)=>e.kind),['progress','verification.passed','walkthrough.ready']);
});
