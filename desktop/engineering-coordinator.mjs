import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_WORKFLOWS = 200;
const MAX_PERSISTED_BYTES = 16 * 1024 * 1024;
const TERMINAL_SWARM_STATES = new Set(['completed', 'partial_success', 'failed', 'cancelled']);
const ACTIVE_ENGINEERING_STATES = new Set(['active']);

function clone(value) { return structuredClone(value); }

function requiredText(value, name, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\\0')) {
    throw new TypeError(name + ' must be a nonempty string of at most ' + max + ' characters');
  }
  return value.trim();
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks) || !checks.length || checks.length > 100) {
    throw new TypeError('verificationChecks must contain 1 to 100 checks');
  }
  return checks.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('verificationChecks[' + index + '] must be an object');
    return {
      check: requiredText(item.check, 'verificationChecks[' + index + '].check', 500),
      passed: Boolean(item.passed),
      evidence: item.evidence ? requiredText(item.evidence, 'verificationChecks[' + index + '].evidence', 5000) : '',
    };
  });
}

function normalizeWalkthrough(value) {
  const walkthrough = requiredText(value, 'walkthrough', 20000);
  const compact = walkthrough.replace(/\s+/g, ' ').trim();
  const words = compact.split(' ').filter(Boolean);
  if (compact.length < 240 || words.length < 35) {
    throw new Error('Completion is blocked until the implementation walkthrough is substantive enough to explain the implemented outcome, architecture/flow, important changes, verification, usage, and remaining limits.');
  }
  return walkthrough;
}

function normalizeMilestoneMap(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('milestoneTaskMap must be an object');
  const result = {};
  for (const [milestone, keys] of Object.entries(value)) {
    if (!Array.isArray(keys) || keys.length > 100) throw new TypeError('milestoneTaskMap values must be task-key arrays');
    result[milestone] = keys.map((key) => requiredText(key, 'milestone task key', 100));
  }
  return result;
}

export class EngineeringCoordinator {
  constructor({ dataDir, engineeringRuntime, swarmManager, onEvent = () => {} } = {}) {
    if (!dataDir || !engineeringRuntime || !swarmManager) throw new TypeError('dataDir, engineeringRuntime and swarmManager are required');
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'engineering-coordination.json');
    this.engineering = engineeringRuntime;
    this.swarms = swarmManager;
    this.onEvent = onEvent;
    this.workflows = new Map();
    this.persistChain = Promise.resolve();
    this.ready = this._load();
  }

  async _load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    let document;
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > MAX_PERSISTED_BYTES) throw new Error('Engineering coordination state exceeds the 16 MiB safety limit');
      document = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error('Could not load engineering coordination state: ' + error.message);
    }
    if (document?.version !== 1 || !Array.isArray(document.workflows)) {
      throw new Error('Engineering coordination state has an unsupported format');
    }
    for (const stored of document.workflows.slice(-MAX_WORKFLOWS)) {
      if (!stored?.id || !stored.protocolId) continue;
      this.workflows.set(stored.id, {
        ...stored,
        milestoneStates: stored.milestoneStates || {},
        artifactIds: stored.artifactIds || [],
        primaryArtifactId: typeof stored.primaryArtifactId === 'string' ? stored.primaryArtifactId : null,
        verificationChecks: stored.verificationChecks || [],
      });
    }
  }

  async _persist() {
    this.persistChain = this.persistChain.then(async () => {
      const document = {
        version: 1,
        savedAt: new Date().toISOString(),
        workflows: [...this.workflows.values()].slice(-MAX_WORKFLOWS),
      };
      const encoded = JSON.stringify(document);
      if (Buffer.byteLength(encoded, 'utf8') > MAX_PERSISTED_BYTES) throw new Error('Engineering coordination state would exceed the 16 MiB safety limit');
      const temp = this.file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
      const backup = this.file + '.bak';
      await fs.writeFile(temp, encoded, { mode: 0o600 });
      let moved = false;
      try {
        try { await fs.rename(this.file, backup); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(temp, this.file);
        await fs.rm(backup, { force: true });
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        if (moved) await fs.rename(backup, this.file).catch(() => {});
        throw error;
      }
    });
    return this.persistChain;
  }

  _emit(workflow, type, details = {}) {
    const event = {
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      protocolId: workflow.protocolId,
      swarmId: workflow.swarmId || null,
      type,
      at: new Date().toISOString(),
      ...clone(details),
    };
    workflow.updatedAt = event.at;
    workflow.lastEvent = event;
    try { this.onEvent(clone(event)); } catch {}
    return event;
  }

  _get(id) {
    const workflow = this.workflows.get(id);
    if (!workflow) throw new Error('Engineering workflow not found: ' + id);
    return workflow;
  }

  async start({
    title,
    description = '',
    complexity = 'large',
    root,
    objective,
    acceptanceCriteria,
    plan,
    milestones = [],
    tasks = [],
    milestoneTaskMap = {},
    requiredArtifacts = [],
    primaryArtifactId,
    maxConcurrency,
  } = {}) {
    await this.ready;
    requiredText(title, 'title', 300);
    requiredText(root, 'root', 2000);
    requiredText(objective, 'objective', 20000);
    requiredText(primaryArtifactId, 'primaryArtifactId', 200);
    if (!Array.isArray(plan) || !plan.length || plan.length > 100) throw new TypeError('plan must contain 1 to 100 items');
    if (!Array.isArray(milestones) || milestones.length > 100) throw new TypeError('milestones must contain at most 100 items');
    const mapping = normalizeMilestoneMap(milestoneTaskMap);
    const now = new Date().toISOString();
    const workflow = {
      id: 'engflow_' + crypto.randomUUID(),
      protocolId: null,
      swarmId: null,
      root: path.resolve(root),
      title: title.trim(),
      objective: objective.trim(),
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      lastSwarmStatus: null,
      lastTaskCounts: {},
      milestoneTaskMap: mapping,
      milestoneStates: {},
      artifactIds: [],
      primaryArtifactId: primaryArtifactId.trim(),
      verificationChecks: [],
      walkthrough: null,
      lastEvent: null,
    };
    this.workflows.set(workflow.id, workflow);

    try {
      const protocol = await this.engineering.start({
        title,
        description,
        complexity,
        requiredArtifacts,
        root: workflow.root,
      });
      workflow.protocolId = protocol.id;
      await this.engineering.plan(protocol.id, plan);
      await this.engineering.goal(protocol.id, { objective, acceptanceCriteria, milestones });
      await this.engineering.primaryArtifact(protocol.id, workflow.primaryArtifactId);
      await this.engineering.requestReview(protocol.id, 'The implementation plan, canonical artifact, goal, acceptance criteria, and milestones are ready. Execution is paused until the user explicitly approves the plan.');
      workflow.status = 'awaiting_user_review';
      workflow.reviewRequired = true;
      workflow.reviewRequestedAt = new Date().toISOString();
      workflow.tasks = clone(tasks);
      workflow.maxConcurrency = maxConcurrency || null;
      this._emit(workflow, 'review.requested', { phase: 'awaiting_user_review', taskCount: tasks.length });
      await this._persist();
      return await this.sync(workflow.id);
    } catch (error) {
      workflow.status = 'failed';
      workflow.error = error.message;
      this._emit(workflow, 'workflow.failed', { message: error.message });
      if (workflow.swarmId) await this.swarms.cancel(workflow.swarmId).catch(() => {});
      if (workflow.protocolId) await this.engineering.fail(workflow.protocolId, 'Coordinator startup failed: ' + error.message).catch(() => {});
      await this._persist();
      throw error;
    }
  }

  _milestoneStatus(workflow, milestoneKey, tasks) {
    const keys = workflow.milestoneTaskMap[milestoneKey] || [];
    if (!keys.length) return 'pending';
    const selected = tasks.filter((task) => keys.includes(task.key));
    if (selected.length !== keys.length) return 'blocked';
    if (selected.some((task) => ['failed', 'blocked', 'timed_out', 'cancelled'].includes(task.state))) return 'blocked';
    if (selected.every((task) => task.state === 'completed')) return 'completed';
    if (selected.some((task) => ['queued', 'running', 'waiting_for_provider'].includes(task.state))) return 'in_progress';
    return 'pending';
  }

  async approve(id, { approvedBy = 'user', note = '' } = {}) {
    await this.ready;
    const workflow = this._get(id);
    if (workflow.status === 'completed' || workflow.status === 'cancelled' || workflow.status === 'failed') {
      throw new Error('Cannot approve a terminal engineering workflow');
    }
    if (workflow.status !== 'awaiting_user_review') return this.sync(id);
    const tasks = Array.isArray(workflow.tasks) ? clone(workflow.tasks) : [];
    await this.engineering.approveReview(workflow.protocolId, { approvedBy, note });
    if (tasks.length) {
      const swarm = await this.swarms.create({
        objective: workflow.objective,
        root: workflow.root,
        ...(workflow.maxConcurrency ? { maxConcurrency: workflow.maxConcurrency } : {}),
      });
      workflow.swarmId = swarm.id;
      await this.engineering.link(workflow.protocolId, { root: workflow.root, swarmId: swarm.id });
      await this.swarms.plan(swarm.id, tasks);
      await this.swarms.start(swarm.id);
      this._emit(workflow, 'swarm.attached', { taskCount: tasks.length });
    }
    workflow.status = 'running';
    workflow.reviewApprovedAt = new Date().toISOString();
    workflow.reviewApprovedBy = approvedBy;
    workflow.reviewNote = note || null;
    this._emit(workflow, 'review.approved', { approvedBy, note: note || null });
    await this._persist();
    return this.sync(id);
  }

  async sync(id) {
    await this.ready;
    const workflow = this._get(id);
    const protocol = this.engineering.status(workflow.protocolId);
    let swarm = null;
    let tasks = [];
    let artifacts = [];
    if (workflow.swarmId) {
      swarm = await this.swarms.status(workflow.swarmId);
      tasks = await this.swarms.taskList(workflow.swarmId);
      artifacts = await this.swarms.artifacts(workflow.swarmId);
      workflow.lastSwarmStatus = swarm.status;
      workflow.lastTaskCounts = clone(swarm.tasks?.counts || {});
      workflow.artifactIds = [...new Set([...(workflow.primaryArtifactId ? [workflow.primaryArtifactId] : []), ...artifacts.map((artifact) => artifact.id)])];
      const total = tasks.length;
      const completed = tasks.filter((task) => task.state === 'completed').length;
      const progress = total ? Math.round((completed / total) * 100) : protocol.progress;
      for (const milestone of protocol.milestones) {
        const next = this._milestoneStatus(workflow, milestone.key, tasks);
        if (next !== 'pending' || workflow.milestoneStates[milestone.key]) {
          workflow.milestoneStates[milestone.key] = next;
        }
        if (next !== milestone.status && protocol.phase === 'execution') {
          await this.engineering.progress(workflow.protocolId,
            'Coordinator reconciled worker state for milestone ' + milestone.key + '.',
            { milestoneKey: milestone.key, status: next });
        }
      }
      if (swarm.status === 'failed' || swarm.status === 'partial_success') {
        if (workflow.status !== 'failed') {
          workflow.status = 'failed';
          await this.engineering.failure(workflow.protocolId, 'Worker swarm ended with ' + swarm.status + '. Inspect task failures before retrying.');
        }
      } else if (swarm.status === 'review_required') {
        workflow.status = 'review_required';
      } else if (swarm.status === 'completed') {
        workflow.status = protocol.state === 'completed' ? 'completed' : protocol.phase === 'walkthrough' ? 'awaiting_code_review' : 'ready_for_verification';
        if (protocol.phase === 'execution') {
          await this.engineering.progress(workflow.protocolId, 'All worker tasks completed; the workflow is waiting for explicit verification and completion gating.', {
            status: 'completed',
          });
        }
      } else if (TERMINAL_SWARM_STATES.has(swarm.status)) {
        workflow.status = swarm.status;
      } else {
        workflow.status = 'running';
        if (protocol.phase === 'execution' && total) {
          await this.engineering.progress(workflow.protocolId,
            'Worker execution is ' + progress + '% complete (' + completed + '/' + total + ' tasks).',
            { status: 'in_progress' });
        }
      }
    } else {
      if (protocol.phase === 'awaiting_user_review' && protocol.state === 'active') workflow.status = 'awaiting_user_review';
      else workflow.status = protocol.state === 'active' ? 'running' : protocol.state;
    }
    workflow.error = null;
    workflow.updatedAt = new Date().toISOString();
    await this._persist();
    return {
      workflow: clone(workflow),
      engineering: this.engineering.status(workflow.protocolId),
      swarm: swarm ? clone(swarm) : null,
      tasks: clone(tasks),
      artifacts: clone(artifacts),
    };
  }

  async finalize(id, { verificationChecks, walkthrough } = {}) {
    await this.ready;
    const workflow = this._get(id);
    const synced = await this.sync(id);
    if (synced.workflow.status === 'awaiting_user_review') throw new Error('Completion is blocked until the user approves the implementation plan');
    if (!synced.swarm) throw new Error('A coordinated workflow requires an attached swarm before finalization');
    if (synced.swarm.status !== 'completed') {
      throw new Error('Completion is blocked until the worker swarm is completed and all write-task integrations are applied');
    }
    const checks = normalizeChecks(verificationChecks);
    if (checks.some((check) => !check.passed)) throw new Error('Completion is blocked because at least one verification check failed');
    const normalizedWalkthrough = normalizeWalkthrough(walkthrough);
    if (!workflow.primaryArtifactId) throw new Error('Completion is blocked until a canonical primary artifact is linked');

    const protocol = synced.engineering;
    if (protocol.phase === 'walkthrough') {
      if (workflow.walkthrough && workflow.walkthrough !== normalizedWalkthrough) throw new Error('The recorded walkthrough cannot be changed while final code review is pending');
      if (JSON.stringify(workflow.verificationChecks) !== JSON.stringify(checks)) throw new Error('The recorded verification results cannot be changed while final code review is pending');
      const completed = await this.engineering.complete(workflow.protocolId);
      workflow.status = 'completed';
      this._emit(workflow, 'workflow.completed', { verificationCount: workflow.verificationChecks.length, artifactCount: workflow.artifactIds.length });
      await this._persist();
      return { workflow: clone(workflow), engineering: completed, swarm: synced.swarm, artifacts: synced.artifacts };
    }
    if (protocol.phase === 'execution') await this.engineering.beginVerification(workflow.protocolId, 'Coordinator is running the explicit completion verification gate.');
    for (const check of checks) await this.engineering.verification(workflow.protocolId, check.check, check.passed, check.evidence);
    if (this.engineering.status(workflow.protocolId).phase === 'verification') await this.engineering.beginArtifacts(workflow.protocolId);

    const artifacts = synced.artifacts;
    const protocolBeforeArtifacts = this.engineering.status(workflow.protocolId);
    if (!protocolBeforeArtifacts.artifacts.some((item) => item.reference === workflow.primaryArtifactId)) {
      await this.engineering.artifact(workflow.protocolId, {
        key: 'primary-artifact',
        kind: 'presentation-artifact',
        title: 'Canonical implementation plan and walkthrough',
        reference: workflow.primaryArtifactId,
        required: true,
      });
    }
    for (const artifact of artifacts) {
      const key = 'swarm-' + artifact.id;
      if (!this.engineering.status(workflow.protocolId).artifacts.some((item) => item.key === key)) {
        await this.engineering.artifact(workflow.protocolId, {
          key,
          kind: artifact.type || 'worker-artifact',
          title: artifact.summary || ('Worker artifact ' + artifact.id),
          reference: artifact.id,
          required: false,
        });
      }
    }
    if (this.engineering.status(workflow.protocolId).phase === 'artifacts') {
      await this.engineering.beginWalkthrough(workflow.protocolId, normalizedWalkthrough);
    }
    workflow.status = 'awaiting_code_review';
    workflow.verificationChecks = checks;
    workflow.walkthrough = normalizedWalkthrough;
    workflow.artifactIds = [workflow.primaryArtifactId, ...artifacts.map((artifact) => artifact.id)];
    this._emit(workflow, 'review.awaiting_presentation', { verificationCount: checks.length, artifactCount: artifacts.length });
    await this._persist();
    return { workflow: clone(workflow), engineering: this.engineering.status(workflow.protocolId), swarm: synced.swarm, artifacts };
  }

  async cancel(id, message = 'Cancelled by user.') {
    await this.ready;
    const workflow = this._get(id);
    if (workflow.swarmId) await this.swarms.cancel(workflow.swarmId).catch(() => {});
    if (workflow.protocolId) await this.engineering.cancel(workflow.protocolId, message).catch(() => {});
    workflow.status = 'cancelled';
    workflow.error = message;
    this._emit(workflow, 'workflow.cancelled', { message });
    await this._persist();
    return this.status(id);
  }

  async recover() {
    await this.ready;
    await this.engineering.ready;
    const active = [...this.workflows.values()].filter((workflow) => workflow.status !== 'completed' && workflow.status !== 'cancelled' && workflow.protocolId);
    for (const workflow of active) {
      try { await this.sync(workflow.id); } catch (error) {
        workflow.status = 'recovery_error';
        workflow.error = error.message;
        this._emit(workflow, 'workflow.recovery_error', { message: error.message });
      }
    }
    await this._persist();
    return this.list({ limit: MAX_WORKFLOWS });
  }

  status(id) {
    const workflow = this._get(id);
    return clone({
      ...workflow,
      engineering: this.engineering.status(workflow.protocolId),
    });
  }

  async list({ status, limit = 50 } = {}) {
    await this.ready;
    const max = Math.max(1, Math.min(200, Number(limit) || 50));
    return [...this.workflows.values()].reverse()
      .filter((item) => !status || item.status === status)
      .slice(0, max)
      .map((item) => clone({
        id: item.id,
        protocolId: item.protocolId,
        swarmId: item.swarmId,
        title: item.title,
        root: item.root,
        status: item.status,
        lastSwarmStatus: item.lastSwarmStatus,
        lastTaskCounts: item.lastTaskCounts,
        artifactCount: item.artifactIds.length,
        primaryArtifactId: item.primaryArtifactId || null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));
  }

  stats() {
    const states = {};
    for (const workflow of this.workflows.values()) states[workflow.status] = (states[workflow.status] || 0) + 1;
    return { workflows: this.workflows.size, states };
  }
}
