import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
const MAX_SESSIONS = 200;
const MAX_BYTES = 8 * 1024 * 1024;
const TERMINAL_PHASES = new Set(['completed','failed','cancelled']);
const TIMELINE_STATUS = new Set(['info','active','success','warning','failed']);

function clone(value) { return structuredClone(value); }
function required(value, name, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(name + ' must be nonempty text');
  return value.trim();
}
function optional(value, name, max = 4000) { return value == null || value === '' ? null : required(value, name, max); }
function uniqueStrings(value, name, max = 100) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw new TypeError(name + ' must be an array of at most ' + max + ' strings');
  return [...new Set(value.map((item,index) => required(item,name+'['+index+']',500)))];
}

export class EngineeringSessionStore {
  constructor({ dataDir, maxSessions = MAX_SESSIONS, maxBytes = MAX_BYTES } = {}) {
    if (!dataDir) throw new TypeError('dataDir is required');
    this.file = path.join(path.resolve(dataDir), 'engineering-sessions.json');
    this.maxSessions = maxSessions;
    this.maxBytes = maxBytes;
    this.sessions = new Map();
    this.persistChain = Promise.resolve();
    this.ready = this._load();
  }

  async _load() {
    try {
      const raw = await fs.readFile(this.file);
      if (raw.length > this.maxBytes) throw new Error('Engineering session state exceeds its size limit');
      const data = JSON.parse(raw.toString('utf8'));
      if (data?.version !== VERSION || !Array.isArray(data.sessions)) throw new Error('Engineering session state has an unsupported format');
      for (const session of data.sessions.slice(-this.maxSessions)) {
        if (!session?.id || !session.protocolId || !session.projectId) continue;
        session.timeline = Array.isArray(session.timeline) ? session.timeline : [];
        session.transactionIds = Array.isArray(session.transactionIds) ? session.transactionIds : [];
        session.transactionStates = session.transactionStates && typeof session.transactionStates === 'object' ? session.transactionStates : {};
        session.memorySnapshotIds = Array.isArray(session.memorySnapshotIds) ? session.memorySnapshotIds : [];
        session.reviewPresentations = Array.isArray(session.reviewPresentations) ? session.reviewPresentations : [];
        this.sessions.set(session.id, session);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async _persist() {
    this.persistChain = this.persistChain.then(async () => {
      const data = { version: VERSION, savedAt:new Date().toISOString(), sessions:[...this.sessions.values()].slice(-this.maxSessions) };
      const encoded = Buffer.from(JSON.stringify(data, null, 2) + '\n');
      if (encoded.length > this.maxBytes) throw new Error('Engineering session state would exceed its size limit');
      await fs.mkdir(path.dirname(this.file), { recursive:true, mode:0o700 });
      const temp = this.file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
      try {
        await fs.writeFile(temp, encoded, { mode:0o600 });
        await fs.rename(temp, this.file);
      } finally {
        await fs.rm(temp,{force:true}).catch(()=>{});
      }
    });
    return this.persistChain;
  }

  async start({ projectId, projectPath, protocolId, workflowId = null, artifactId, phase = 'execution', memorySnapshotIds = [] } = {}) {
    await this.ready;
    const existing = [...this.sessions.values()].find((item) => item.protocolId === protocolId && !TERMINAL_PHASES.has(item.phase));
    if (existing) return clone(existing);
    const now = new Date().toISOString();
    const session = {
      id:'engsession_' + crypto.randomUUID(),
      projectId:required(projectId,'projectId',128),
      projectPath:required(projectPath,'projectPath',4000),
      protocolId:required(protocolId,'protocolId',200),
      workflowId:optional(workflowId,'workflowId',200),
      artifactId:required(artifactId,'artifactId',200),
      phase:required(phase,'phase',80),
      status:'active',
      memorySnapshotIds:uniqueStrings(memorySnapshotIds,'memorySnapshotIds'),
      transactionIds:[],
      transactionStates:{},
      verification:[],
      walkthroughReady:false,
      reviewPresentations:[],
      timeline:[],
      createdAt:now,
      updatedAt:now,
    };
    this.sessions.set(session.id, session);
    this._append(session,{ kind:'session.started', label:'Engineering session started', detail:'ForgeLink linked the approved workflow to durable session state.', status:'active', phase:session.phase });
    await this._persist();
    return clone(session);
  }

  _get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Engineering session not found: ' + id);
    return session;
  }

  _append(session, { kind, label, detail = '', status = 'info', phase = session.phase, references = {} } = {}) {
    if (!TIMELINE_STATUS.has(status)) throw new TypeError('Invalid timeline status');
    const event = {
      id:crypto.randomUUID(),
      sessionId:session.id,
      protocolId:session.protocolId,
      workflowId:session.workflowId,
      phase:required(phase,'phase',80),
      kind:required(kind,'kind',120),
      label:required(label,'label',300),
      detail:detail ? required(detail,'detail',4000) : '',
      status,
      at:new Date().toISOString(),
      references:clone(references || {}),
    };
    session.timeline.push(event);
    if (session.timeline.length > 1000) session.timeline.splice(0, session.timeline.length - 1000);
    session.updatedAt = event.at;
    return event;
  }

  async timelineEvent(id, event) {
    await this.ready;
    const session = this._get(id);
    const created = this._append(session,event);
    await this._persist();
    return clone(created);
  }

  async addMemorySnapshot(id, snapshotId, detail = '') {
    await this.ready;
    const session = this._get(id);
    const clean = required(snapshotId,'snapshotId',200);
    if (!session.memorySnapshotIds.includes(clean)) session.memorySnapshotIds.push(clean);
    const event = this._append(session,{kind:'memory.loaded',label:'Project memory loaded',detail:detail || 'Relevant project-scoped semantic context was supplied to ChatGPT.',status:'success',references:{snapshotId:clean}});
    await this._persist();
    return clone(event);
  }

  async linkTransaction(id, { transactionId, state = 'previewed', paths = [] } = {}) {
    await this.ready;
    const session = this._get(id);
    const tx = required(transactionId,'transactionId',200);
    if (!session.transactionIds.includes(tx)) session.transactionIds.push(tx);
    const previousState = session.transactionStates[tx] || null;
    session.transactionStates[tx] = required(state,'state',80);
    if (previousState === state) return null;
    const status = state === 'rolled_back' || state === 'undone' ? 'warning' : state === 'committed' || state === 'redone' ? 'success' : state === 'failed' ? 'failed' : 'active';
    const event = this._append(session,{
      kind:'transaction.' + state,
      label:'Transaction ' + state.replace(/_/g,' '),
      detail:paths.length ? paths.length + ' path(s) linked to this operation.' : '',
      status,
      references:{ transactionId:tx, paths:uniqueStrings(paths,'paths',50) },
    });
    await this._persist();
    return clone(event);
  }

  async recordVerification(id, { check, passed, evidence = '' } = {}) {
    await this.ready;
    const session = this._get(id);
    const result = { id:crypto.randomUUID(), check:required(check,'check',500), passed:Boolean(passed), evidence:evidence ? required(evidence,'evidence',4000) : '', at:new Date().toISOString() };
    session.verification.push(result);
    this._append(session,{kind:'verification.'+(result.passed?'passed':'failed'),label:result.passed?'Verification passed':'Verification failed',detail:result.check,status:result.passed?'success':'failed',references:{verificationId:result.id}});
    await this._persist();
    return clone(result);
  }

  async markWalkthrough(id, detail = 'The final implementation walkthrough is ready.') {
    await this.ready;
    const session = this._get(id);
    session.walkthroughReady = true;
    session.phase = 'walkthrough';
    const event = this._append(session,{kind:'walkthrough.ready',label:'Walkthrough ready',detail,status:'success',phase:'walkthrough'});
    await this._persist();
    return clone(event);
  }

  async recordReviewPresentation(id, { transactionId, reviewId } = {}) {
    await this.ready;
    const session = this._get(id);
    const item = { transactionId:required(transactionId,'transactionId',200), reviewId:required(reviewId,'reviewId',200), presentedAt:new Date().toISOString() };
    if (!session.transactionIds.includes(item.transactionId)) throw new Error('Review transaction is not linked to this engineering session');
    if (session.transactionStates[item.transactionId] !== 'committed') throw new Error('Only a committed transaction review may complete an engineering session');
    const existing = session.reviewPresentations.find((presentation)=>presentation.transactionId===item.transactionId && presentation.reviewId===item.reviewId);
    if (existing) return clone(session.timeline.find((event)=>event.kind==='review.presented' && event.references.transactionId===item.transactionId && event.references.reviewId===item.reviewId) || existing);
    session.reviewPresentations.push(item);
    const event = this._append(session,{kind:'review.presented',label:'Code changes reviewed',detail:'Exact transaction-scoped Code Changes / Diff presentation was shown.',status:'success',phase:'walkthrough',references:item});
    await this._persist();
    return clone(event);
  }

  async setPhase(id, phase, { status = 'active', detail = '' } = {}) {
    await this.ready;
    const session = this._get(id);
    session.phase = required(phase,'phase',80);
    session.status = required(status,'status',80);
    const event = this._append(session,{kind:'phase.changed',label:'Phase: '+session.phase.replace(/_/g,' '),detail,status:TERMINAL_PHASES.has(session.phase)?(session.phase==='completed'?'success':'failed'):'active',phase:session.phase});
    await this._persist();
    return clone(event);
  }

  async assertCompletable(id) {
    await this.ready;
    const session = this._get(id);
    const latestByCheck = new Map();
    for (const item of session.verification) latestByCheck.set(item.check,item);
    if (!latestByCheck.size || [...latestByCheck.values()].some((item)=>!item.passed)) throw new Error('Engineering session has failing or missing verification');
    if (!session.walkthroughReady) throw new Error('Engineering session walkthrough is not ready');
    const committed = session.transactionIds.filter((transactionId)=>session.transactionStates[transactionId] === 'committed');
    if (!committed.length) throw new Error('Engineering session has no committed coding transaction');
    const missing = committed.filter((transactionId)=>!session.reviewPresentations.some((review)=>review.transactionId===transactionId));
    if (missing.length) throw new Error('Engineering session has transaction reviews that were not presented: ' + missing.join(', '));
    return true;
  }

  async status(id) { await this.ready; return clone(this._get(id)); }

  async findByProtocol(protocolId) {
    await this.ready;
    const found = [...this.sessions.values()].filter((item)=>item.protocolId===protocolId).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    return found ? clone(found) : null;
  }

  async findByTransaction(transactionId) {
    await this.ready;
    const tx = required(transactionId,'transactionId',200);
    const found = [...this.sessions.values()].filter((item)=>item.status === 'active' && item.transactionIds.includes(tx)).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    return found ? clone(found) : null;
  }

  async recordProtocolEvent(protocolId, event = {}) {
    await this.ready;
    const session = [...this.sessions.values()].filter((item)=>item.protocolId===protocolId && item.status === 'active').sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (!session || !event?.type) return null;
    let created = null;
    if (event.type === 'phase.changed') {
      session.phase = event.to || event.phase || session.phase;
      created = this._append(session,{kind:'phase.changed',label:'Phase: '+session.phase.replace(/_/g,' '),detail:event.from ? 'Advanced from '+String(event.from).replace(/_/g,' ')+'.' : '',status:session.phase==='completed'?'success':'active',phase:session.phase});
    } else if (event.type === 'verification.result' && event.result) {
      if (!session.verification.some((item)=>item.id===event.result.id)) session.verification.push(clone(event.result));
      created = this._append(session,{kind:event.result.passed?'verification.passed':'verification.failed',label:event.result.passed?'Verification passed':'Verification failed',detail:event.result.check || '',status:event.result.passed?'success':'failed',phase:event.phase || session.phase,references:{verificationId:event.result.id}});
    } else if (event.type === 'explanation' && event.kind === 'walkthrough.start') {
      session.walkthroughReady = true;
      session.phase = 'walkthrough';
      created = this._append(session,{kind:'walkthrough.ready',label:'Walkthrough ready',detail:'The canonical implementation walkthrough entered its final presentation phase.',status:'success',phase:'walkthrough'});
    } else if (event.type === 'execution.progress') {
      created = this._append(session,{kind:'progress',label:event.milestoneKey ? 'Milestone progress' : 'Engineering progress',detail:event.message || '',status:event.status==='blocked'?'warning':event.status==='completed'?'success':'active',phase:event.phase || session.phase,references:{milestoneKey:event.milestoneKey || null}});
    } else if (event.type === 'failure.recorded') {
      created = this._append(session,{kind:'failure',label:'Engineering failure recorded',detail:event.failure?.message || '',status:'failed',phase:event.phase || session.phase,references:{failureId:event.failure?.id || null}});
    } else if (event.type === 'decision.recorded') {
      created = this._append(session,{kind:'decision',label:'Engineering decision recorded',detail:event.decision?.title || '',status:'info',phase:event.phase || session.phase,references:{decisionId:event.decision?.id || null}});
    } else if (event.type === 'artifact.created' || event.type === 'artifacts.started') {
      created = this._append(session,{kind:'artifact.updated',label:'Canonical artifact updated',detail:'Implementation evidence is being persisted in the workflow artifact.',status:'success',phase:event.phase || session.phase});
    } else if (event.type === 'completed') {
      session.phase = 'completed';
      session.status = 'completed';
      created = this._append(session,{kind:'workflow.completed',label:'Engineering workflow completed',detail:'All protocol completion gates passed.',status:'success',phase:'completed'});
    } else if (event.type === 'failed') {
      session.status = 'failed';
      created = this._append(session,{kind:'workflow.failed',label:'Engineering workflow failed',detail:event.message || '',status:'failed',phase:event.phase || session.phase});
    } else if (event.type === 'cancelled') {
      session.status = 'cancelled';
      created = this._append(session,{kind:'workflow.cancelled',label:'Engineering workflow cancelled',detail:event.message || '',status:'warning',phase:event.phase || session.phase});
    }
    if (!created) return null;
    await this._persist();
    return clone(created);
  }

  async timeline(id, { limit = 100 } = {}) {
    await this.ready;
    const session = this._get(id);
    return { sessionId:id, phase:session.phase, status:session.status, events:clone(session.timeline.slice(-Math.min(Math.max(1,limit),500))) };
  }
}
