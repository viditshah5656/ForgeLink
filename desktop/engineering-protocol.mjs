import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ENGINEERING_PHASES = Object.freeze([
  'understanding',
  'planning',
  'goal',
  'awaiting_user_review',
  'execution',
  'verification',
  'artifacts',
  'walkthrough',
  'completed',
]);

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const PHASE_ORDER = new Map(ENGINEERING_PHASES.map((phase, index) => [phase, index]));
const MAX_TEXT = 20_000;
const MAX_CRITERIA = 100;
const MAX_MILESTONES = 100;
const MAX_UPDATES = 500;

function text(value, name, max = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\\0')) {
    throw new TypeError(`${name} must be a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}

function walkthroughText(value) {
  const walkthrough = text(value, 'walkthrough');
  const compact = walkthrough.replace(/\s+/g, ' ');
  const words = compact.split(' ').filter(Boolean);
  if (compact.length < 240 || words.length < 35) {
    throw new Error('A substantive implementation walkthrough is required before the engineering protocol can enter the walkthrough phase.');
  }
  return walkthrough;
}

function list(value, name, max) {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`${name} must be an array of at most ${max} items`);
  return value.map((item, index) => text(item, `${name}[${index}]`, 2_000));
}

function clone(value) {
  return structuredClone(value);
}

/**
 * External engineering-governance state for substantial agent work.
 *
 * This module deliberately does not execute tools. It defines the contract that
 * execution layers (task graph, worker orchestrator, artifact manager, UI/MCP)
 * can consume and report against.
 */
export class EngineeringProtocol {
  constructor({
    id = crypto.randomUUID(),
    title,
    description = '',
    complexity = 'large',
    requiredArtifacts = [],
    onUpdate = () => {},
  } = {}) {
    this.id = text(id, 'id', 128);
    this.title = text(title, 'title', 300);
    this.description = description ? text(description, 'description') : '';
    if (!['medium', 'large', 'system'].includes(complexity)) throw new TypeError('complexity must be medium, large, or system');
    this.complexity = complexity;
    this.state = 'active';
    this.phase = 'understanding';
    this.goal = null;
    this.plan = [];
    this.acceptanceCriteria = [];
    this.milestones = [];
    this.review = { required: true, status: 'pending', requestedAt: null, approvedAt: null, approvedBy: null, note: null };
    this.decisions = [];
    this.artifacts = [];
    this.primaryArtifactId = null;
    this.walkthrough = null;
    this.updateLog = [];
    this.failures = [];
    this.verificationResults = [];
    this.operations = [];
    this.changeReviews = [];
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    if (!Array.isArray(requiredArtifacts) || requiredArtifacts.length > 100) throw new TypeError('requiredArtifacts must be an array of at most 100 items');
    this.requiredArtifacts = requiredArtifacts.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`requiredArtifacts[${index}] must be an object`);
      return {
        key: text(item.key, `requiredArtifacts[${index}].key`, 100),
        description: text(item.description || item.key, `requiredArtifacts[${index}].description`, 2_000),
        required: item.required !== false,
      };
    });
    if (typeof onUpdate !== 'function') throw new TypeError('onUpdate must be a function');
    this.onUpdate = onUpdate;
  }

  _emit(type, payload = {}) {
    const event = {
      id: crypto.randomUUID(),
      protocolId: this.id,
      at: new Date().toISOString(),
      type,
      phase: this.phase,
      ...clone(payload),
    };
    this.updatedAt = event.at;
    this.updateLog.push(event);
    if (this.updateLog.length > MAX_UPDATES) this.updateLog.shift();
    try { this.onUpdate(clone(event)); } catch { /* observers cannot corrupt protocol state */ }
    return event;
  }

  _requireActive() {
    if (this.state !== 'active') throw new Error(`Protocol is ${this.state}`);
  }

  _setPhase(next) {
    const current = PHASE_ORDER.get(this.phase);
    const target = PHASE_ORDER.get(next);
    if (target === undefined) throw new TypeError(`Unknown engineering phase: ${next}`);
    if (target < current) throw new Error(`Engineering phase cannot move backward: ${this.phase} -> ${next}`);
    if (target > current + 1) throw new Error(`Engineering phase cannot skip: ${this.phase} -> ${next}`);
    if (next !== this.phase) {
      this.phase = next;
      this._emit('phase.changed', { from: ENGINEERING_PHASES[current], to: next });
    }
  }

  explain(message, { kind = 'progress', phase = this.phase } = {}) {
    this._requireActive();
    text(message, 'message');
    if (!ENGINEERING_PHASES.includes(phase)) throw new TypeError(`Unknown engineering phase: ${phase}`);
    return this._emit('explanation', { kind, message, phase });
  }

  definePlan(items) {
    this._requireActive();
    this._setPhase('planning');
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_MILESTONES) throw new RangeError('plan must contain 1 to 100 items');
    this.plan = items.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`plan[${index}] must be an object`);
      return {
        key: text(item.key || `step-${index + 1}`, `plan[${index}].key`, 100),
        title: text(item.title, `plan[${index}].title`, 300),
        description: item.description ? text(item.description, `plan[${index}].description`) : '',
        status: item.status || 'pending',
      };
    });
    this._emit('plan.created', { plan: this.plan });
    return clone(this.plan);
  }

  linkPrimaryArtifact(artifactId) {
    this._requireActive();
    const next = text(artifactId, 'artifactId', 200);
    if (this.primaryArtifactId && this.primaryArtifactId !== next) throw new Error('Primary artifact is already linked for this workflow');
    this.primaryArtifactId = next;
    return this._emit('artifact.primary_linked', { primaryArtifactId: next });
  }

  defineGoal({ objective, acceptanceCriteria, milestones = [] } = {}) {
    this._requireActive();
    this._setPhase('goal');
    this.goal = text(objective, 'objective');
    this.acceptanceCriteria = list(acceptanceCriteria, 'acceptanceCriteria', MAX_CRITERIA);
    if (!this.acceptanceCriteria.length) throw new RangeError('acceptanceCriteria must contain at least one item');
    if (!Array.isArray(milestones) || milestones.length > MAX_MILESTONES) throw new TypeError('milestones must be an array of at most 100 items');
    this.milestones = milestones.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`milestones[${index}] must be an object`);
      return { key: text(item.key, `milestones[${index}].key`, 100), title: text(item.title, `milestones[${index}].title`, 300), status: 'pending' };
    });
    this._emit('goal.defined', { goal: this.goal, acceptanceCriteria: this.acceptanceCriteria, milestones: this.milestones });
    return this.snapshot();
  }

  requestReview(message = 'Implementation plan is ready for your review.') {
    this._requireActive();
    if (!this.goal || !this.plan.length) throw new Error('Define the plan and goal before requesting user review');
    this._setPhase('awaiting_user_review');
    this.review = { ...this.review, required: true, status: 'pending', requestedAt: new Date().toISOString(), approvedAt: null, approvedBy: null, note: null };
    return this.explain(message, { kind: 'review.requested', phase: 'awaiting_user_review' });
  }

  approveReview({ approvedBy = 'user', note = '' } = {}) {
    this._requireActive();
    if (this.phase !== 'awaiting_user_review') throw new Error('User review is not pending');
    this.review = { ...this.review, required: true, status: 'approved', approvedAt: new Date().toISOString(), approvedBy: text(approvedBy, 'approvedBy', 120), note: note ? text(note, 'note', 2_000) : null };
    this._emit('review.approved', { review: this.review });
    this._setPhase('execution');
    return this.explain('User approved the implementation plan. Execution may begin.', { kind: 'execution.start', phase: 'execution' });
  }

  beginExecution(message = 'Beginning implementation.') {
    this._requireActive();
    if (!this.goal) throw new Error('Define the goal before execution');
    if (this.phase !== 'execution') throw new Error('User review approval is required before execution');
    return this.explain(message, { kind: 'execution.start' });
  }

  progress(message, { milestoneKey = null, status = 'in_progress' } = {}) {
    this._requireActive();
    if (!['execution', 'verification', 'artifacts', 'walkthrough'].includes(this.phase)) throw new Error('Progress updates require an active execution or completion phase');
    if (milestoneKey) {
      const milestone = this.milestones.find((item) => item.key === milestoneKey);
      if (!milestone) throw new Error(`Unknown milestone: ${milestoneKey}`);
      if (!['pending', 'in_progress', 'completed', 'blocked'].includes(status)) throw new TypeError('Invalid milestone status');
      milestone.status = status;
    }
    return this._emit('execution.progress', { message: text(message, 'message'), milestoneKey, status, milestones: this.milestones });
  }

  recordDecision(title, rationale, alternatives = []) {
    this._requireActive();
    const decision = {
      id: crypto.randomUUID(),
      title: text(title, 'title', 300),
      rationale: text(rationale, 'rationale'),
      alternatives: Array.isArray(alternatives) ? alternatives.map((item, index) => text(item, `alternatives[${index}]`, 2_000)) : [],
      at: new Date().toISOString(),
    };
    this.decisions.push(decision);
    return this._emit('decision.recorded', { decision });
  }

  recordFailure(message, recovery = '') {
    this._requireActive();
    const failure = { id: crypto.randomUUID(), message: text(message, 'message'), recovery: recovery ? text(recovery, 'recovery') : '', at: new Date().toISOString() };
    this.failures.push(failure);
    return this._emit('failure.recorded', { failure });
  }

  beginVerification(message = 'Running verification against the acceptance criteria.') {
    this._requireActive();
    this._setPhase('verification');
    return this.explain(message, { kind: 'verification.start' });
  }

  recordVerification(check, passed, evidence = '') {
    this._requireActive();
    if (this.phase !== 'verification') throw new Error('Verification records require the verification phase');
    const result = {
      id: crypto.randomUUID(),
      check: text(check, 'check', 500),
      passed: Boolean(passed),
      evidence: evidence ? text(evidence, 'evidence', 5_000) : '',
      at: new Date().toISOString(),
    };
    this.verificationResults.push(result);
    return this._emit('verification.result', { result });
  }

  beginArtifacts() {
    this._requireActive();
    if (!this.primaryArtifactId) throw new Error('A canonical primary artifact is required before the artifacts phase');
    this._setPhase('artifacts');
    if (!this.artifacts.some((artifact) => artifact.reference === this.primaryArtifactId)) {
      this.artifacts.push({
        id: crypto.randomUUID(),
        key: 'primary-artifact',
        kind: 'presentation-artifact',
        title: 'Canonical implementation plan and walkthrough',
        reference: this.primaryArtifactId,
        required: true,
        at: new Date().toISOString(),
      });
    }
    return this._emit('artifacts.started', { requiredArtifacts: this.requiredArtifacts, primaryArtifactId: this.primaryArtifactId });
  }

  recordArtifact({ key, kind = 'document', title, reference = null, required = true } = {}) {
    this._requireActive();
    if (this.phase !== 'artifacts') throw new Error('Artifacts can only be recorded in the artifacts phase');
    const artifact = {
      id: crypto.randomUUID(),
      key: text(key, 'key', 100),
      kind: text(kind, 'kind', 80),
      title: text(title, 'title', 300),
      reference: reference ? text(reference, 'reference', 2_000) : null,
      required: required !== false,
      at: new Date().toISOString(),
    };
    this.artifacts.push(artifact);
    return this._emit('artifact.created', { artifact });
  }

  beginWalkthrough(message) {
    this._requireActive();
    const walkthrough = walkthroughText(message);
    this._setPhase('walkthrough');
    this.walkthrough = walkthrough;
    return this.explain(this.walkthrough, { kind: 'walkthrough.start' });
  }

  recordOperation({ operationId, paths = [], reviewId, fileCount, addedLines, removedLines } = {}) {
    this._requireActive();
    if (!['execution', 'verification', 'artifacts', 'walkthrough'].includes(this.phase)) throw new Error('Implementation operations require an approved execution phase');
    const id = text(operationId, 'operationId', 128);
    const review = text(reviewId, 'reviewId', 128);
    if (!Array.isArray(paths) || !paths.length || paths.some((item) => typeof item !== 'string' || !item)) throw new TypeError('Operation paths are required');
    if (![fileCount, addedLines, removedLines].every((value) => Number.isSafeInteger(value) && value >= 0) || fileCount < 1) throw new TypeError('Exact review counts are required');
    const existing = this.operations.find((item) => item.operationId === id);
    if (existing) {
      if (existing.reviewId !== review || existing.fileCount !== fileCount || existing.addedLines !== addedLines || existing.removedLines !== removedLines || JSON.stringify(existing.paths) !== JSON.stringify(paths)) throw new Error('Operation review changed after it was recorded');
      return clone(existing);
    }
    const operation = { operationId: id, paths: clone(paths), reviewId: review, fileCount, addedLines, removedLines, recordedAt: new Date().toISOString() };
    this.operations.push(operation);
    this._emit('operation.recorded', { operation });
    return clone(operation);
  }

  recordReviewPresentation(operationId, reviewId) {
    this._requireActive();
    if (this.phase !== 'walkthrough') throw new Error('The final code review must be presented after the walkthrough');
    const operation = this.operations.find((item) => item.operationId === operationId && item.reviewId === reviewId);
    if (!operation) throw new Error('No matching committed operation review is linked to this workflow');
    const existing = this.changeReviews.find((item) => item.operationId === operationId);
    if (existing) return clone(existing);
    const presentation = { operationId, reviewId, presentedAt: new Date().toISOString() };
    this.changeReviews.push(presentation);
    this._emit('review.presented', { presentation });
    return clone(presentation);
  }

  invalidateReviewPresentation(operationId) {
    if (this.state !== 'active') return false;
    const length = this.changeReviews.length;
    this.changeReviews = this.changeReviews.filter((item) => item.operationId !== operationId);
    if (this.changeReviews.length !== length) this._emit('review.invalidated', { operationId });
    return this.changeReviews.length !== length;
  }

  complete() {
    this._requireActive();
    if (this.phase !== 'walkthrough') throw new Error('Walkthrough must be completed before the protocol can complete');
    if (!this.goal || !this.plan.length) throw new Error('Goal and plan are required');
    if (!this.primaryArtifactId) throw new Error('A canonical primary artifact is required');
    if (!this.walkthrough) throw new Error('A stored implementation walkthrough is required');
    if (!this.verificationResults.length) throw new Error('At least one verification result is required before completion');
    const latestVerification = new Map();
    for (const result of this.verificationResults) latestVerification.set(result.check, result);
    if ([...latestVerification.values()].some((result) => !result.passed)) throw new Error('Latest verification results must pass before completion');
    if (!this.artifacts.some((artifact) => artifact.reference === this.primaryArtifactId)) throw new Error('The canonical primary artifact must be recorded before completion');
    const missing = this.requiredArtifacts.filter((required) => !this.artifacts.some((artifact) => artifact.key === required.key));
    if (missing.length) throw new Error(`Required artifacts missing: ${missing.map((item) => item.key).join(', ')}`);
    if (this.milestones.some((item) => item.status !== 'completed')) throw new Error('All milestones must be completed before final completion');
    if (!this.operations.length) throw new Error('At least one committed implementation operation with an exact code review is required before completion');
    if (this.operations.some((operation) => !this.changeReviews.some((review) => review.operationId === operation.operationId && review.reviewId === operation.reviewId))) throw new Error('The workflow Code Changes / Diff card must be presented after the walkthrough and cover every committed operation before completion');
    this.phase = 'completed';
    this.state = 'completed';
    return this._emit('completed', { snapshot: this.snapshot() });
  }

  fail(message) {
    if (this.state !== 'active') throw new Error(`Protocol is ${this.state}`);
    this.state = 'failed';
    return this._emit('failed', { message: text(message, 'message') });
  }

  cancel(message = 'Cancelled by user.') {
    if (this.state !== 'active') throw new Error(`Protocol is ${this.state}`);
    this.state = 'cancelled';
    return this._emit('cancelled', { message: text(message, 'message') });
  }

  snapshot() {
    return clone({
      id: this.id,
      title: this.title,
      description: this.description,
      complexity: this.complexity,
      state: this.state,
      phase: this.phase,
      goal: this.goal,
      plan: this.plan,
      acceptanceCriteria: this.acceptanceCriteria,
      milestones: this.milestones,
      review: this.review,
      decisions: this.decisions,
      artifacts: this.artifacts,
      primaryArtifactId: this.primaryArtifactId,
      walkthrough: this.walkthrough,
      requiredArtifacts: this.requiredArtifacts,
      failures: this.failures,
      verificationResults: this.verificationResults,
      operations: this.operations,
      changeReviews: this.changeReviews,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      progress: this.milestones.length
        ? Math.round((this.milestones.filter((item) => item.status === 'completed').length / this.milestones.length) * 100)
        : 0,
    });
  }

  updates() {
    return clone(this.updateLog);
  }
}

const RUNTIME_STATES = new Set(['active', 'completed', 'failed', 'cancelled']);
const MAX_PROTOCOLS = 500;
const MAX_PERSISTED_BYTES = 16 * 1024 * 1024;

function protocolRecord(snapshot, links = {}) {
  return {
    ...clone(snapshot),
    links: {
      root: typeof links.root === 'string' ? links.root : null,
      jobId: typeof links.jobId === 'string' ? links.jobId : null,
      taskId: typeof links.taskId === 'string' ? links.taskId : null,
      swarmId: typeof links.swarmId === 'string' ? links.swarmId : null,
    },
  };
}

/**
 * Runtime owner for EngineeringProtocol instances.
 * Phase 2 makes the protocol durable and observable without coupling the
 * protocol itself to MCP, the event bus, or a particular scheduler.
 */
export class EngineeringRuntime {
  constructor({ dataDir, onEvent = () => {} } = {}) {
    if (typeof dataDir !== 'string' || !dataDir.trim()) throw new TypeError('dataDir is required');
    if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'engineering-protocols.json');
    this.protocols = new Map();
    this.onEvent = onEvent;
    this.persistChain = Promise.resolve();
    this.ready = this._load();
  }

  async _load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    let document;
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > MAX_PERSISTED_BYTES) throw new Error('Engineering protocol state exceeds the 16 MiB safety limit');
      document = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error('Could not load engineering protocol state: ' + error.message);
    }
    if (document?.version !== 1 || !Array.isArray(document.protocols)) {
      throw new Error('Engineering protocol state has an unsupported format');
    }
    for (const stored of document.protocols.slice(-MAX_PROTOCOLS)) {
      if (!stored?.id || !RUNTIME_STATES.has(stored.state) || !ENGINEERING_PHASES.includes(stored.phase)) continue;
      const protocol = new EngineeringProtocol({
        id: stored.id,
        title: stored.title,
        description: stored.description || '',
        complexity: stored.complexity,
        requiredArtifacts: stored.requiredArtifacts || [],
        onUpdate: (event) => this._observe(stored.id, event),
      });
      protocol.state = stored.state;
      protocol.phase = stored.phase;
      protocol.goal = stored.goal ?? null;
      protocol.plan = clone(stored.plan || []);
      protocol.acceptanceCriteria = clone(stored.acceptanceCriteria || []);
      protocol.milestones = clone(stored.milestones || []);
      protocol.review = clone(stored.review || { required: true, status: 'pending', requestedAt: null, approvedAt: null, approvedBy: null, note: null });
      protocol.decisions = clone(stored.decisions || []);
      protocol.artifacts = clone(stored.artifacts || []);
      protocol.primaryArtifactId = typeof stored.primaryArtifactId === 'string' ? stored.primaryArtifactId : null;
      protocol.walkthrough = typeof stored.walkthrough === 'string' ? stored.walkthrough : null;
      protocol.failures = clone(stored.failures || []);
      protocol.verificationResults = clone(stored.verificationResults || []);
      protocol.operations = clone(stored.operations || []);
      protocol.changeReviews = clone(stored.changeReviews || []);
      protocol.updateLog = clone(stored.updates || []);
      protocol.createdAt = stored.createdAt || protocol.createdAt;
      protocol.updatedAt = stored.updatedAt || protocol.updatedAt;
      this.protocols.set(protocol.id, { protocol, links: clone(stored.links || {}) });
    }
  }

  async _persist() {
    this.persistChain = this.persistChain.then(async () => {
      const document = {
        version: 1,
        savedAt: new Date().toISOString(),
        protocols: [...this.protocols.values()].slice(-MAX_PROTOCOLS).map(({ protocol, links }) =>
          ({ ...protocolRecord(protocol.snapshot(), links), updates: protocol.updates() })),
      };
      const encoded = JSON.stringify(document);
      if (Buffer.byteLength(encoded, 'utf8') > MAX_PERSISTED_BYTES) {
        throw new Error('Engineering protocol state would exceed the 16 MiB safety limit');
      }
      const temporary = this.file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
      const backup = this.file + '.bak';
      await fs.writeFile(temporary, encoded, { mode: 0o600 });
      let movedOriginal = false;
      try {
        try {
          await fs.rename(this.file, backup);
          movedOriginal = true;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await fs.rename(temporary, this.file);
        await fs.rm(backup, { force: true });
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        if (movedOriginal) await fs.rename(backup, this.file).catch(() => {});
        throw error;
      }
    });
    return this.persistChain;
  }

  _observe(id, event) {
    try {
      this.onEvent(clone(event));
    } catch {
      // Runtime observers cannot corrupt protocol state.
    }
    void this._persist().catch(() => {});
  }

  _record(id) {
    const record = this.protocols.get(id);
    if (!record) throw new Error('Engineering protocol not found: ' + id);
    return record;
  }

  async start({ title, description = '', complexity = 'large', requiredArtifacts = [], primaryArtifactId = null, root = null, jobId = null, taskId = null, swarmId = null } = {}) {
    await this.ready;
    if (this.protocols.size >= MAX_PROTOCOLS) throw new Error('At most ' + MAX_PROTOCOLS + ' engineering protocols may be retained');
    let protocol;
    protocol = new EngineeringProtocol({
      title,
      description,
      complexity,
      requiredArtifacts,
      onUpdate: (event) => this._observe(protocol.id, event),
    });
    this.protocols.set(protocol.id, { protocol, links: { root, jobId, taskId, swarmId } });
    if (primaryArtifactId) protocol.linkPrimaryArtifact(primaryArtifactId);
    protocol.explain('Engineering session initialized; repository inspection, canonical artifact, and workflow state will be tracked here.', { kind: 'session.start' });
    await this._persist();
    return this.status(protocol.id);
  }

  async plan(id, items) {
    await this.ready;
    this._record(id).protocol.definePlan(items);
    await this._persist();
    return this.status(id);
  }

  async goal(id, input) {
    await this.ready;
    this._record(id).protocol.defineGoal(input);
    await this._persist();
    return this.status(id);
  }

  async primaryArtifact(id, artifactId) {
    await this.ready;
    this._record(id).protocol.linkPrimaryArtifact(artifactId);
    await this._persist();
    return this.status(id);
  }

  async requestReview(id, message) {
    await this.ready;
    this._record(id).protocol.requestReview(message);
    await this._persist();
    return this.status(id);
  }

  async approveReview(id, input = {}) {
    await this.ready;
    this._record(id).protocol.approveReview(input);
    await this._persist();
    return this.status(id);
  }

  async beginExecution(id, message) {
    await this.ready;
    this._record(id).protocol.beginExecution(message);
    await this._persist();
    return this.status(id);
  }

  async progress(id, message, options = {}) {
    await this.ready;
    this._record(id).protocol.progress(message, options);
    await this._persist();
    return this.status(id);
  }

  async decision(id, title, rationale, alternatives = []) {
    await this.ready;
    this._record(id).protocol.recordDecision(title, rationale, alternatives);
    await this._persist();
    return this.status(id);
  }

  async failure(id, message, recovery = '') {
    await this.ready;
    this._record(id).protocol.recordFailure(message, recovery);
    await this._persist();
    return this.status(id);
  }

  async beginVerification(id, message) {
    await this.ready;
    this._record(id).protocol.beginVerification(message);
    await this._persist();
    return this.status(id);
  }

  async verification(id, check, passed, evidence = '') {
    await this.ready;
    this._record(id).protocol.recordVerification(check, passed, evidence);
    await this._persist();
    return this.status(id);
  }

  async beginArtifacts(id) {
    await this.ready;
    this._record(id).protocol.beginArtifacts();
    await this._persist();
    return this.status(id);
  }

  async artifact(id, input) {
    await this.ready;
    this._record(id).protocol.recordArtifact(input);
    await this._persist();
    return this.status(id);
  }

  async beginWalkthrough(id, message) {
    await this.ready;
    this._record(id).protocol.beginWalkthrough(message);
    await this._persist();
    return this.status(id);
  }

  async recordOperation(id, input) {
    await this.ready;
    this._record(id).protocol.recordOperation(input);
    await this._persist();
    return this.status(id);
  }

  async recordOwnedOperation(id, input) {
    await this.ready;
    const owner = this._record(id);
    const operationId = text(input?.operationId, 'operationId', 128);
    for (const [otherId, record] of this.protocols.entries()) {
      if (otherId === id) continue;
      const index = record.protocol.operations.findIndex((item) => item.operationId === operationId);
      if (index < 0) continue;
      if (record.protocol.state !== 'active') {
        throw new Error('A committed operation cannot be reassigned away from a terminal engineering workflow');
      }
      record.protocol.operations.splice(index, 1);
      record.protocol.changeReviews = record.protocol.changeReviews.filter((item) => item.operationId !== operationId);
      record.protocol._emit('operation.reassigned', { operationId, toProtocolId: id });
    }
    owner.protocol.recordOperation(input);
    await this._persist();
    return this.status(id);
  }

  async recordReviewPresentation(id, operationId, reviewId) {
    await this.ready;
    this._record(id).protocol.recordReviewPresentation(operationId, reviewId);
    await this._persist();
    return this.status(id);
  }

  async acknowledgeReview(operationId, reviewId) {
    await this.ready;
    const matches = [...this.protocols.values()].filter(({ protocol }) => protocol.operations.some((operation) => operation.operationId === operationId && operation.reviewId === reviewId));
    if (matches.length !== 1) throw new Error('The code review does not match exactly one engineering workflow');
    if (matches[0].protocol.state === 'completed' && matches[0].protocol.changeReviews.some((review) => review.operationId === operationId && review.reviewId === reviewId)) return this.status(matches[0].protocol.id);
    if (matches[0].protocol.state !== 'active') throw new Error('The engineering workflow is no longer active');
    return this.recordReviewPresentation(matches[0].protocol.id, operationId, reviewId);
  }

  async invalidateReview(operationId) {
    await this.ready;
    let changed = false;
    for (const { protocol } of this.protocols.values()) changed = protocol.invalidateReviewPresentation(operationId) || changed;
    if (changed) await this._persist();
    return changed;
  }

  async complete(id) {
    await this.ready;
    this._record(id).protocol.complete();
    await this._persist();
    return this.status(id);
  }

  async fail(id, message) {
    await this.ready;
    this._record(id).protocol.fail(message);
    await this._persist();
    return this.status(id);
  }

  async cancel(id, message) {
    await this.ready;
    this._record(id).protocol.cancel(message);
    await this._persist();
    return this.status(id);
  }

  async explain(id, message, options = {}) {
    await this.ready;
    this._record(id).protocol.explain(message, options);
    await this._persist();
    return this.status(id);
  }

  async link(id, links = {}) {
    await this.ready;
    const record = this._record(id);
    record.links = {
      ...record.links,
      root: typeof links.root === 'string' ? links.root : record.links.root,
      jobId: typeof links.jobId === 'string' ? links.jobId : record.links.jobId,
      taskId: typeof links.taskId === 'string' ? links.taskId : record.links.taskId,
      swarmId: typeof links.swarmId === 'string' ? links.swarmId : record.links.swarmId,
    };
    await this._persist();
    return this.status(id);
  }

  async authorizeMutation({ targets = [], operation = 'engineering mutation' } = {}) {
    await this.ready;
    if (!Array.isArray(targets) || !targets.length) throw new TypeError('targets must contain at least one path');
    const normalizeCase = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    const canonicalPath = async (value) => {
      let candidate = path.resolve(text(value, 'target path', 10_000));
      const missing = [];
      for (;;) {
        try {
          const existing = await fs.realpath(candidate);
          return normalizeCase(path.join(existing, ...missing.reverse()));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          const parent = path.dirname(candidate);
          if (parent === candidate) throw error;
          missing.push(path.basename(candidate));
          candidate = parent;
        }
      }
    };
    const normalizedTargets = await Promise.all(targets.map(canonicalPath));
    const contains = (root, candidate) => {
      const relative = path.relative(root, candidate);
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
    };
    const candidates = (await Promise.all([...this.protocols.values()].map(async (record) => ({
      ...record,
      canonicalRoot: typeof record.links.root === 'string' && record.links.root.trim()
        ? await canonicalPath(record.links.root) : null,
    }))))
      .filter(({ protocol, canonicalRoot }) =>
        protocol.state === 'active' && canonicalRoot &&
        normalizedTargets.every((target) => contains(canonicalRoot, target)))
      .sort((left, right) => {
        const rootDelta = right.canonicalRoot.length - left.canonicalRoot.length;
        if (rootDelta) return rootDelta;
        return Date.parse(right.protocol.updatedAt || 0) - Date.parse(left.protocol.updatedAt || 0);
      });

    if (!candidates.length) {
      const error = new Error(`ENGINEERING_WORKFLOW_REQUIRED: ${operation} targets a project workspace but no active ForgeLink engineering workflow owns every target path.`);
      error.code = 'ENGINEERING_WORKFLOW_REQUIRED';
      throw error;
    }

    const selected = candidates[0];
    const { protocol } = selected;
    const executable = protocol.review?.status === 'approved' &&
      protocol.primaryArtifactId &&
      ['execution', 'verification', 'artifacts', 'walkthrough'].includes(protocol.phase);
    if (!executable) {
      const code = protocol.phase === 'awaiting_user_review' || protocol.review?.status !== 'approved'
        ? 'ENGINEERING_APPROVAL_REQUIRED'
        : 'ENGINEERING_WORKFLOW_NOT_EXECUTABLE';
      const error = new Error(`${code}: ${operation} is blocked until the linked implementation plan is explicitly approved and this same workflow enters execution.`);
      error.code = code;
      throw error;
    }

    return protocolRecord(protocol.snapshot(), selected.links);
  }

  status(id) {
    const record = this._record(id);
    return protocolRecord(record.protocol.snapshot(), record.links);
  }

  list({ state, phase, limit = 50 } = {}) {
    const maximum = Math.max(1, Math.min(200, Number(limit) || 50));
    return [...this.protocols.values()]
      .reverse()
      .filter(({ protocol }) => (!state || protocol.state === state) && (!phase || protocol.phase === phase))
      .slice(0, maximum)
      .map(({ protocol, links }) => protocolRecord(protocol.snapshot(), links));
  }

  history(id, limit = 100) {
    const record = this._record(id);
    const maximum = Math.max(1, Math.min(500, Number(limit) || 100));
    return record.protocol.updates().slice(-maximum);
  }

  stats() {
    const states = { active: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const { protocol } of this.protocols.values()) states[protocol.state]++;
    return { protocols: this.protocols.size, states };
  }
}
