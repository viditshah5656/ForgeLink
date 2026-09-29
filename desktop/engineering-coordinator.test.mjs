import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EngineeringCoordinator } from './engineering-coordinator.mjs';

function fakeEngineering() {
  const protocols = new Map();
  return {
    async start(input) {
      const id = crypto.randomUUID();
      protocols.set(id, { id, phase:'understanding', state:'active', milestones:[], artifacts:[], operations:[], changeReviews:[], progress:0 });
      return this.status(id);
    },
    async plan(id) { protocols.get(id).phase='planning'; return this.status(id); },
    async goal(id, input) { const p=protocols.get(id); p.phase='goal'; p.milestones=(input.milestones||[]).map(x=>({...x,status:'pending'})); return this.status(id); },
    async primaryArtifact(id, artifactId) { protocols.get(id).primaryArtifactId=artifactId; return this.status(id); },
    async requestReview(id) { protocols.get(id).phase='awaiting_user_review'; return this.status(id); },
    async approveReview(id) { protocols.get(id).phase='execution'; return this.status(id); },
    async beginExecution(id) { protocols.get(id).phase='execution'; return this.status(id); },
    async link() {},
    async progress(id, message, options={}) { const p=protocols.get(id); if(options.milestoneKey){const m=p.milestones.find(x=>x.key===options.milestoneKey);if(m)m.status=options.status;} return this.status(id); },
    async failure(id) { protocols.get(id).state='failed'; return this.status(id); },
    async beginVerification(id) { protocols.get(id).phase='verification'; return this.status(id); },
    async verification() {},
    async beginArtifacts(id) { protocols.get(id).phase='artifacts'; return this.status(id); },
    async artifact(id, input) { protocols.get(id).artifacts.push(input); return this.status(id); },
    async beginWalkthrough(id) { protocols.get(id).phase='walkthrough'; return this.status(id); },
    async complete(id) { const p=protocols.get(id); if (!p.operations.length || p.changeReviews.length !== p.operations.length) throw new Error('Final code review has not been presented'); p.phase='completed';p.state='completed';return this.status(id); },
    markReviewPresented(id) { const p=protocols.get(id); p.operations=[{operationId:'op-1',reviewId:'review-1'}];p.changeReviews=[{operationId:'op-1',reviewId:'review-1'}]; },
    async cancel(id) { protocols.get(id).state='cancelled'; return this.status(id); },
    status(id) { const p=protocols.get(id); return structuredClone({...p,id}); },
  };
}

function fakeSwarm() {
  const swarms = new Map();
  return {
    async create(input) { const id='swarm_'+Math.random().toString(16).slice(2); swarms.set(id,{id,status:'draft',root:input.root,tasks:[]}); return {id}; },
    async plan(id, tasks) { const s=swarms.get(id); s.tasks=tasks.map((x,i)=>({id:'task_'+i,key:x.key,state:'pending',dependencies:x.dependencies||[],mode:x.mode||'read',outputs:[]})); return this.status(id); },
    async start(id) { const s=swarms.get(id); s.status='running'; for(const t of s.tasks)t.state='completed'; s.status='completed'; return this.status(id); },
    async status(id) { const s=swarms.get(id); const counts={pending:0,queued:0,running:0,completed:0,failed:0,blocked:0,timed_out:0,cancelled:0,waiting_for_provider:0}; for(const t of s.tasks)counts[t.state]++; return {id:s.id,status:s.status,root:s.root,tasks:{counts}}; },
    async taskList(id) { return structuredClone(swarms.get(id).tasks); },
    async artifacts(id) { return []; },
    async cancel(id) { swarms.get(id).status='cancelled'; },
  };
}

test('coordinator starts, links, syncs and persists a workflow', async () => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'forgelink-coordinator-'));
  const engineering=fakeEngineering(), swarms=fakeSwarm();
  const coordinator=new EngineeringCoordinator({dataDir,engineeringRuntime:engineering,swarmManager:swarms});
  const started=await coordinator.start({
    title:'Coordinator smoke',
    root:dataDir,
    objective:'Coordinate worker execution',
    acceptanceCriteria:['workers complete'],
    plan:[{key:'p1',title:'Execute'}],
    milestones:[{key:'m1',title:'Worker work'}],
    milestoneTaskMap:{m1:['worker']},
    primaryArtifactId:'artifact_coordinator_primary',
    tasks:[{key:'worker',prompt:'do work',readPaths:['.']}],
  });
  assert.equal(started.workflow.status,'awaiting_user_review');
  assert.equal(started.swarm,null);
  const approved=await coordinator.approve(started.workflow.id,{approvedBy:'user',note:'Approved.'});
  assert.equal(approved.workflow.status,'ready_for_verification');
  assert.equal(approved.swarm.status,'completed');
  const repeated=await coordinator.approve(started.workflow.id,{approvedBy:'user'});
  assert.equal(repeated.workflow.swarmId,approved.workflow.swarmId);
  const restored=new EngineeringCoordinator({dataDir,engineeringRuntime:engineering,swarmManager:swarms});
  const listed=await restored.list({limit:10});
  assert.equal(listed.length,1);
  assert.equal(listed[0].swarmId,approved.workflow.swarmId);
  await fs.rm(dataDir,{recursive:true,force:true});
});

test('recovery waits for engineering runtime hydration before synchronizing persisted workflows', async () => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'forgelink-coordinator-recovery-'));
  const engineering=fakeEngineering(), swarms=fakeSwarm();
  const coordinator=new EngineeringCoordinator({dataDir,engineeringRuntime:engineering,swarmManager:swarms});
  const started=await coordinator.start({
    title:'Recovery ordering',root:dataDir,objective:'Recover after restart',
    acceptanceCriteria:['workflow survives restart'],plan:[{key:'p1',title:'Execute'}],
    milestones:[],primaryArtifactId:'artifact_recovery_primary',tasks:[],
  });
  let hydrated=false;
  const originalStatus=engineering.status.bind(engineering);
  engineering.ready=new Promise((resolve)=>setTimeout(()=>{hydrated=true;resolve();},20));
  engineering.status=(id)=>{if(!hydrated)throw new Error('engineering runtime not hydrated');return originalStatus(id);};
  coordinator._get(started.workflow.id).error='transient startup failure';
  await coordinator._persist();
  const restored=new EngineeringCoordinator({dataDir,engineeringRuntime:engineering,swarmManager:swarms});
  const recovered=await restored.recover();
  assert.equal(recovered[0].id,started.workflow.id);
  assert.notEqual(recovered[0].status,'recovery_error');
  assert.equal(restored.status(started.workflow.id).error,null);
  await fs.rm(dataDir,{recursive:true,force:true});
});

test('completion gate rejects failed verification and accepts passing verification', async () => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'forgelink-coordinator-'));
  const engineering=fakeEngineering(), swarms=fakeSwarm();
  const coordinator=new EngineeringCoordinator({dataDir,engineeringRuntime:engineering,swarmManager:swarms});
  const started=await coordinator.start({
    title:'Completion smoke',root:dataDir,objective:'Complete safely',
    acceptanceCriteria:['pass'],plan:[{key:'p1',title:'Execute'}],
    milestones:[],primaryArtifactId:'artifact_completion_primary',tasks:[{key:'worker',prompt:'work',readPaths:['.']}],
  });
  await assert.rejects(() => coordinator.finalize(started.workflow.id,{verificationChecks:[{check:'test',passed:false}],walkthrough:'done'}),/user approves|verification check failed/);
  await coordinator.approve(started.workflow.id,{approvedBy:'user'});
  await assert.rejects(
    () => coordinator.finalize(started.workflow.id,{
      verificationChecks:[{check:'test',passed:true,evidence:'exit 0'}],
      walkthrough:'Implementation and verification complete.',
    }),
    /walkthrough is substantive enough/i,
  );
  const walkthrough='The implementation completed the requested workflow using the existing coordinator and persisted engineering protocol. The coordinator owns the completion gate, links the canonical artifact, records verification evidence, and then advances into the walkthrough phase. The changed flow keeps execution state durable, explains the important integration boundary, records how the result is used, and preserves the verified artifact as the user-facing reference. Verification passed with exit code 0, and the remaining limitation is that this test uses the local fake engineering and swarm runtimes rather than an external production host.';
  const pending=await coordinator.finalize(started.workflow.id,{verificationChecks:[{check:'test',passed:true,evidence:'exit 0'}],walkthrough});
  assert.equal(pending.workflow.status,'awaiting_code_review');
  await assert.rejects(() => coordinator.finalize(started.workflow.id,{verificationChecks:[{check:'test',passed:true,evidence:'exit 0'}],walkthrough}), /review has not been presented/);
  engineering.markReviewPresented(started.workflow.protocolId);
  const done=await coordinator.finalize(started.workflow.id,{verificationChecks:[{check:'test',passed:true,evidence:'exit 0'}],walkthrough});
  assert.equal(done.workflow.status,'completed');
  assert.equal(done.engineering.state,'completed');
  assert.equal(done.workflow.primaryArtifactId,'artifact_completion_primary');
  assert.ok(done.workflow.artifactIds.includes('artifact_completion_primary'));
  await fs.rm(dataDir,{recursive:true,force:true});
});
