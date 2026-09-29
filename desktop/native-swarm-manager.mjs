import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskGraph, TASK_PRIORITIES } from './task-graph.mjs';

const MAX_SWARMS = 200;
const MAX_TASKS_PER_SWARM = 100;
const MAX_EVENTS_PER_SWARM = 2000;
const MAX_PERSISTED_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGE_COUNT = 2000;
const MAX_BLACKBOARD_KEYS = 100;
const MAX_AGENT_MEMORY_ENTRIES = 3000;
const MAX_SHARED_DATA_BYTES = 2 * 1024 * 1024;
const MAX_WAIT_EDGES = 100;
const MAX_DEADLOCK_RECORDS = 100;
const TERMINAL_SWARMS = new Set(['completed', 'partial_success', 'failed', 'cancelled']);
const TERMINAL_TASKS = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'blocked']);
const SCHEDULABLE_SWARM_STATES = new Set(['running', 'queued', 'waiting_for_provider']);
const MESSAGE_TYPES = new Set(['TASK_ASSIGNED', 'STATUS', 'QUESTION', 'ANSWER', 'BLOCKED', 'ARTIFACT_READY', 'HANDOFF', 'REQUEST_REVIEW', 'REVIEW_RESULT', 'TEST_RESULT', 'CONFLICT', 'ERROR', 'DEPENDENCY_READY', 'CANCEL']);

function safeError(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 2000)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}

function defaultConcurrency() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const freeRamGb = os.freemem() / (1024 ** 3);
  const configured = Number(process.env.FORGELINK_MAX_AGENT_CONCURRENCY);
  const resourceLimit = Math.max(1, Math.floor(freeRamGb / 1.5));
  const suggested = Math.max(1, Math.min(64, cpus - 1 || 1, resourceLimit));
  return Number.isInteger(configured) ? Math.max(1, Math.min(64, configured)) : suggested;
}

function clone(value) { return structuredClone(value); }

function strictRelative(root, input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 1024 || input.includes('\0') || path.isAbsolute(input) || /^[a-z]:/i.test(input)) {
    throw new Error('Scope must be a nonempty relative path of at most 1024 characters');
  }
  const normalized = input.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => part === '..' || (part === '.' && input !== '.'))) throw new Error('Scope paths cannot contain traversal or interior dot segments');
  const resolved = path.resolve(root, input);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Scope path escapes the swarm root');
  return resolved;
}

function boundedJson(value, name, maximum = 16 * 1024) {
  let text;
  try { text = JSON.stringify(value); } catch { throw new TypeError(`${name} must be JSON serializable`); }
  if (text === undefined || Buffer.byteLength(text, 'utf8') > maximum) throw new RangeError(`${name} exceeds the ${maximum}-byte JSON limit`);
  if (/-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/-]+=*|(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET|PASSWORD)\s*[:=]\s*[^\s,;"']{8,}/i.test(text)) {
    throw new Error(`${name} contains credential-like content and was not stored`);
  }
  return JSON.parse(text);
}

function validateBlackboardKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(key)) throw new TypeError('key must be 1 to 64 safe ASCII characters');
  return key;
}

function agentFunction(name, description, properties) {
  return { type: 'function', name, description, strict: true,
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } };
}

function safeResult(value) {
  if (value == null) return null;
  let text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024) text = `${text.slice(0, 512 * 1024)}[truncated]`;
  try { return JSON.parse(text); } catch { return { summary: safeError('Result could not be serialized') }; }
}

export function buildRoutedContext(swarm, task) {
  const dependencies = task.dependencies.map((key) => {
    const upstream = swarm.tasks.find((item) => item.key === key);
    const artifact = upstream && swarm.artifacts.findLast((item) => item.taskId === upstream.id);
    return upstream ? {
      taskKey: upstream.key,
      title: upstream.title,
      status: upstream.state,
      result: artifact ? { type: artifact.type, summary: artifact.summary, files: artifact.files, content: artifact.content } : null,
    } : null;
  }).filter(Boolean);
  const explicitInputs = task.inputs.map((input) => {
    const artifact = swarm.artifacts.findLast((item) => item.id === input || item.taskId === input || swarm.tasks.find((candidate) => candidate.id === item.taskId)?.key === input);
    return artifact ? { type: artifact.type, summary: artifact.summary, files: artifact.files, content: artifact.content } : input;
  });
  const failures = dependencies.filter((entry) => entry.status === 'failed' || entry.status === 'timed_out' || entry.status === 'blocked')
    .map(({ taskKey, status, result }) => ({ taskKey, status, error: result?.summary || null }));
  const context = { objective: swarm.objective, dependencies, inputs: explicitInputs, relevantFailures: failures };
  let encoded = JSON.stringify(context);
  while (Buffer.byteLength(encoded, 'utf8') > 48 * 1024 && dependencies.length) {
    const largest = dependencies.reduce((selected, entry, index) => {
      const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      return !selected || size > selected.size ? { index, size } : selected;
    }, null);
    dependencies[largest.index] = { ...dependencies[largest.index], result: dependencies[largest.index].result
      ? { ...dependencies[largest.index].result, content: '[Dependency artifact omitted: context budget exceeded]' } : null };
    encoded = JSON.stringify(context);
    if (largest.size < 256) break;
  }
  if (Buffer.byteLength(encoded, 'utf8') > 48 * 1024) {
    for (const input of explicitInputs) if (input && typeof input === 'object' && 'content' in input) input.content = '[Artifact omitted: context budget exceeded]';
    encoded = JSON.stringify(context);
  }
  return JSON.parse(encoded);
}

function taskForAgent(task, root, swarm) {
  return {
    root,
    swarmId: swarm.id,
    taskId: task.id,
    prompt: task.prompt || task.description || task.title,
    label: task.label || task.title,
    role: task.role,
    mode: task.mode,
    readPaths: task.readPaths,
    writePaths: task.writePaths,
    provider: 'chatgpt_web',
    processAccess: task.processAccess,
    model: task.model,
    reasoning: task.reasoning,
    maxTurns: task.maxTurns,
    maxOutputTokens: task.maxOutputTokens,
    timeoutMs: task.timeoutMs,
    parentTaskKey: task.parentTaskKey,
    spawnDepth: task.spawnDepth,
    blackboardReadKeys: task.blackboardReadKeys,
    blackboardWriteKeys: task.blackboardWriteKeys,
    routedContext: buildRoutedContext(swarm, task),
  };
}

/** Durable swarm/task orchestration around ForgeLink's existing scoped agent executor. */
export class NativeSwarmManager {
  constructor({ dataDir, subagents, maxConcurrency = defaultConcurrency(), captureBaseline = async (root) => ({ root, capturedAt: new Date().toISOString() }), onEvent = () => {},
    captureResources = async () => ({ cpu: Math.max(1, (os.availableParallelism?.() || os.cpus().length) - 1), ram_mb: Math.floor(os.freemem() / (1024 ** 2)), vram_mb: 0, processes: 128 }),
    pollIntervalMs = 250 } = {}) {
    if (!dataDir || !subagents) throw new TypeError('dataDir and subagents are required');
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'native-swarms.json');
    this.subagents = subagents;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) throw new RangeError('maxConcurrency must be from 1 to 64');
    this.maxConcurrency = maxConcurrency;
    this.captureBaseline = captureBaseline;
    this.captureResources = captureResources;
    this.lastResources = null;
    this.onEvent = onEvent;
    this.pollIntervalMs = Math.max(50, Math.min(5000, pollIntervalMs));
    this.swarms = new Map();
    this.schedulers = new Set();
    this.schedulerLocked = false;
    this.pendingPumps = new Set();
    this.resourcePollers = new Map();
    this.persistChain = Promise.resolve();
    this.ready = this._load();
    this.subagents.setAgentToolsFactory?.((context) => this.createAgentTools(context));
  }

  async _load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    let document;
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > MAX_PERSISTED_BYTES) throw new Error('Native swarm state exceeds the 32 MiB safety limit');
      document = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        try {
          const backup = `${this.file}.bak`;
          const stat = await fs.stat(backup);
          if (stat.size > MAX_PERSISTED_BYTES) throw new Error('Native swarm backup exceeds the 32 MiB safety limit');
          document = JSON.parse(await fs.readFile(backup, 'utf8'));
        } catch (backupError) {
          if (backupError.code === 'ENOENT') return;
          throw new Error(`Could not load persisted swarm backup: ${safeError(backupError)}`);
        }
      } else throw new Error(`Could not load persisted swarm state: ${safeError(error)}`);
    }
    if (document?.version !== 1 || !Array.isArray(document.swarms)) throw new Error('Persisted swarm state has an unsupported format');
    for (const stored of document.swarms.slice(-MAX_SWARMS)) {
      const swarm = clone(stored);
      const previousStatus = swarm.status;
      const interruptedTasks = [];
      swarm.messages ||= [];
      swarm.waitEdges ||= [];
      swarm.deadlocks ||= [];
      swarm.events ||= [];
      swarm.artifacts ||= [];
      swarm.blackboard ||= {};
      swarm.memory ||= [];
      const graph = new TaskGraph(swarm.tasks || []);
      for (const task of graph.list()) {
        if (['queued', 'running'].includes(task.state)) {
          interruptedTasks.push({ taskId: task.id, taskKey: task.key, previousState: task.state, agentId: task.assignedAgentId || undefined });
          graph.transition(task.id, 'pending', { assignedAgentId: null, startedAt: null, completedAt: null, error: 'Work was interrupted by a ForgeLink restart; resume the swarm to retry safely.' });
        } else if (task.state === 'waiting_for_provider') {
          interruptedTasks.push({ taskId: task.id, taskKey: task.key, previousState: task.state, agentId: task.assignedAgentId || undefined });
          graph.transition(task.id, 'pending', { assignedAgentId: null, startedAt: null, completedAt: null, error: 'Provider wait was interrupted by a ForgeLink restart; resume the swarm to retry.' });
        }
      }
      swarm.tasks = graph.list();
      const activeAgents = new Set(swarm.tasks.filter((task) => ['queued', 'running'].includes(task.state) && task.assignedAgentId).map((task) => task.assignedAgentId));
      const previousEdgeCount = swarm.waitEdges.length;
      swarm.waitEdges = swarm.waitEdges.filter((edge) => activeAgents.has(edge.fromAgentId) && activeAgents.has(edge.toAgentId));
      if (swarm.waitEdges.length !== previousEdgeCount) {
        for (const deadlock of swarm.deadlocks) if (!deadlock.resolved) {
          deadlock.resolved = true;
          deadlock.resolvedAt = new Date().toISOString();
          deadlock.resolution = 'Wait edges were cleared during restart recovery.';
        }
      }
      if (['running', 'waiting_for_provider'].includes(swarm.status)) swarm.status = 'paused';
      swarm.updatedAt = new Date().toISOString();
      this.swarms.set(swarm.id, swarm);
      for (const task of interruptedTasks) this._emit(swarm, 'task.recovered', { ...task, state: 'pending', reason: 'ForgeLink restarted before this task completed.' });
      if (interruptedTasks.length || previousStatus !== swarm.status) {
        this._emit(swarm, 'swarm.recovered', {
          previousStatus,
          status: swarm.status,
          interruptedTaskIds: interruptedTasks.map((task) => task.taskId),
          interruptedTaskCount: interruptedTasks.length,
          clearedWaitEdgeCount: previousEdgeCount - swarm.waitEdges.length,
        });
      }
    }
    if (this.swarms.size) await this._persist();
  }

  async _persist() {
    this.persistChain = this.persistChain.then(async () => {
      const document = { version: 1, savedAt: new Date().toISOString(), swarms: [...this.swarms.values()].slice(-MAX_SWARMS) };
      const text = JSON.stringify(document);
      if (Buffer.byteLength(text, 'utf8') > MAX_PERSISTED_BYTES) throw new Error('Swarm state would exceed the 32 MiB persistence limit');
      const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const backup = `${this.file}.bak`;
      await fs.writeFile(temp, text, { mode: 0o600 });
      let movedOriginal = false;
      try {
        try { await fs.rename(this.file, backup); movedOriginal = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(temp, this.file);
        await fs.rm(backup, { force: true });
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        if (movedOriginal) await fs.rename(backup, this.file).catch(() => {});
        throw error;
      }
    });
    return this.persistChain;
  }

  _get(swarmId) {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);
    return swarm;
  }

  _emit(swarm, type, details = {}) {
    const event = { id: crypto.randomUUID(), swarmId: swarm.id, type, at: new Date().toISOString(), ...details };
    swarm.events.push(event);
    if (swarm.events.length > MAX_EVENTS_PER_SWARM) swarm.events.splice(0, swarm.events.length - MAX_EVENTS_PER_SWARM);
    swarm.updatedAt = event.at;
    try { this.onEvent(clone(event)); } catch { /* Event consumers cannot break swarm execution. */ }
    return event;
  }

  _graph(swarm) { return new TaskGraph(swarm.tasks); }

  _pruneWaitEdges(swarm, resolution = 'An agent is no longer active.') {
    const active = new Set(swarm.tasks.filter((task) => ['queued', 'running'].includes(task.state) && task.assignedAgentId).map((task) => task.assignedAgentId));
    const remaining = swarm.waitEdges.filter((edge) => active.has(edge.fromAgentId) && active.has(edge.toAgentId));
    if (remaining.length === swarm.waitEdges.length) return;
    swarm.waitEdges = remaining;
    this._resolveDeadlocks(swarm, resolution);
  }

  _resolveDeadlocks(swarm, resolution = 'The wait-for cycle was cleared.') {
    const livePairs = new Set(swarm.waitEdges.map((edge) => `${edge.fromAgentId}\0${edge.toAgentId}`));
    for (const deadlock of swarm.deadlocks) {
      if (deadlock.resolved) continue;
      if (deadlock.edges.some((edge) => !livePairs.has(`${edge.fromAgentId}\0${edge.toAgentId}`))) {
        deadlock.resolved = true;
        deadlock.resolvedAt = new Date().toISOString();
        deadlock.resolution = resolution;
        this._emit(swarm, 'deadlock.resolved', { deadlockId: deadlock.id, resolution });
      }
    }
  }

  _refreshStatus(swarm) {
    const graph = this._graph(swarm);
    const tasks = graph.list();
    if (swarm.status === 'cancelled' || swarm.status === 'paused' || swarm.status === 'draft') return;
    const counts = graph.summary().counts;
    if (tasks.length && counts.completed === tasks.length) {
      const needsIntegration = tasks.some((task) => task.mode === 'write' && task.outputs.length && !task.integratedAt);
      swarm.status = needsIntegration ? 'review_required' : 'completed';
      if (!needsIntegration) swarm.completedAt ||= new Date().toISOString();
    }
    else if (counts.queued || counts.running) swarm.status = 'running';
    else if (counts.waiting_for_provider) swarm.status = 'waiting_for_provider';
    else if (counts.pending) swarm.status = 'queued';
    else if (counts.failed || counts.timed_out || counts.blocked || counts.cancelled) {
      swarm.status = counts.completed ? 'partial_success' : 'failed';
    }
  }

  _transition(swarm, taskId, state, patch = {}) {
    const graph = this._graph(swarm);
    const task = graph.transition(taskId, state, patch);
    swarm.tasks = graph.list();
    this._pruneWaitEdges(swarm);
    this._emit(swarm, `task.${state}`, { taskId, taskKey: task.key, agentId: task.assignedAgentId || undefined });
    this._refreshStatus(swarm);
    return task;
  }

  _updateTask(swarm, taskId, patch = {}) {
    const graph = this._graph(swarm);
    const task = graph.update(taskId, patch);
    swarm.tasks = graph.list();
    this._emit(swarm, 'task.updated', { taskId, taskKey: task.key, agentId: task.assignedAgentId || undefined });
    return task;
  }

  async create({ objective, root, maxConcurrency = defaultConcurrency(), baseline } = {}) {
    await this.ready;
    if (this.swarms.size >= MAX_SWARMS) throw new Error(`At most ${MAX_SWARMS} swarms may be retained`);
    if (typeof objective !== 'string' || !objective.trim() || objective.length > 4000) throw new TypeError('objective must contain 1 to 4000 characters');
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('root must be an approved absolute workspace path');
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) throw new RangeError('maxConcurrency must be from 1 to 64');
    const captured = baseline || await this.captureBaseline(root);
    const now = new Date().toISOString();
    const swarm = {
      id: `swarm_${crypto.randomUUID()}`, objective: objective.trim(), root, maxConcurrency,
      status: 'draft', createdAt: now, updatedAt: now, startedAt: null, completedAt: null,
      baseline: safeResult(captured), tasks: [], messages: [], waitEdges: [], deadlocks: [], events: [], artifacts: [], blackboard: {}, memory: [],
    };
    this.swarms.set(swarm.id, swarm);
    this._emit(swarm, 'swarm.created', { taskCount: 0 });
    await this._persist();
    return this.status(swarm.id);
  }

  async plan(swarmId, inputs) {
    await this.ready;
    const swarm = this._get(swarmId);
    if (TERMINAL_SWARMS.has(swarm.status)) throw new Error('Cannot add tasks to a terminal swarm');
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > MAX_TASKS_PER_SWARM) throw new RangeError(`Plan must contain 1 to ${MAX_TASKS_PER_SWARM} tasks`);
    if (swarm.tasks.length + inputs.length > MAX_TASKS_PER_SWARM) throw new RangeError(`A swarm may contain at most ${MAX_TASKS_PER_SWARM} tasks`);
    for (const input of inputs) {
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new TypeError(`Task ${input.key || ''} requires a prompt`);
      if (input.mode === 'write' && (!Array.isArray(input.writePaths) || !input.writePaths.length)) throw new Error(`Write task ${input.key || ''} requires explicit write paths`);
      if (input.processAccess === true && input.resourceRequirements?.processes === 0) throw new Error('Tasks with process access must reserve at least one process slot');
      if (!TASK_PRIORITIES.includes(String(input.priority || 'NORMAL').toUpperCase())) throw new Error(`Invalid priority for task ${input.key || ''}`);
      for (const key of [...(input.blackboardReadKeys || []), ...(input.blackboardWriteKeys || [])]) validateBlackboardKey(key);
    }
    const graph = this._graph(swarm);
    const added = graph.add(inputs.map((input) => ({ ...input, priority: String(input.priority || 'NORMAL').toUpperCase() })));
    swarm.tasks = graph.list();
    this._emit(swarm, 'swarm.planned', { taskCount: swarm.tasks.length, addedTaskKeys: added.map((task) => task.key) });
    await this._persist();
    if (SCHEDULABLE_SWARM_STATES.has(swarm.status)) await this._pump(swarmId);
    return this.status(swarmId);
  }

  async start(swarmId) {
    await this.ready;
    const swarm = this._get(swarmId);
    if (TERMINAL_SWARMS.has(swarm.status)) throw new Error('Cannot start a terminal swarm');
    if (!swarm.tasks.length) throw new Error('Create at least one planned task before starting the swarm');
    this._graph(swarm).validate();
    if (swarm.status !== 'running') {
      swarm.status = 'running';
      swarm.startedAt ||= new Date().toISOString();
      this._emit(swarm, 'swarm.started', { taskCount: swarm.tasks.length });
      await this._persist();
    }
    await this._pump(swarmId);
    return this.status(swarmId);
  }

  async _pump(swarmId) {
    await this.ready;
    if (this.schedulerLocked || this.schedulers.has(swarmId)) {
      this.pendingPumps.add(swarmId);
      return;
    }
    this.schedulerLocked = true;
    this.schedulers.add(swarmId);
    try {
      const swarm = this._get(swarmId);
      if (!SCHEDULABLE_SWARM_STATES.has(swarm.status)) return;
      let graph = this._graph(swarm);
      for (const task of graph.blockedByFailure()) {
        this._transition(swarm, task.id, 'blocked', { error: 'A required dependency did not complete successfully.' });
      }
      graph = this._graph(swarm);
      const active = graph.list().filter((task) => ['queued', 'running'].includes(task.state)).length;
      const allTasks = [...this.swarms.values()].flatMap((item) => item.tasks);
      const globalActive = allTasks.filter((task) => ['queued', 'running'].includes(task.state)).length;
      const capacity = Math.max(0, Math.min(swarm.maxConcurrency - active, this.maxConcurrency - globalActive));
      const resources = await this.captureResources();
      this.lastResources = resources;
      const reserved = allTasks.filter((task) => ['queued', 'running'].includes(task.state))
        .reduce((used, task) => ({ cpu: used.cpu + task.resourceRequirements.cpu, ram_mb: used.ram_mb + task.resourceRequirements.ram_mb,
          vram_mb: used.vram_mb + task.resourceRequirements.vram_mb, processes: used.processes + task.resourceRequirements.processes }),
        { cpu: 0, ram_mb: 0, vram_mb: 0, processes: 0 });
      let scheduled = 0;
      for (const task of graph.ready({ limit: 100 })) {
        const demand = task.resourceRequirements;
        const impossible = Object.keys(demand).filter((key) => demand[key] > (Number(resources?.[key]) || 0));
        if (impossible.length) {
          const reason = impossible.map((key) => `${key}: needs ${demand[key]}, available ${Number(resources?.[key]) || 0}`).join('; ');
          if (task.schedulingBlocker !== reason) {
            this._updateTask(swarm, task.id, { schedulingBlocker: reason });
            this._emit(swarm, 'task.resource_starved', { taskId: task.id, taskKey: task.key, requirements: demand, available: resources, reason });
          }
          continue;
        }
        if (task.schedulingBlocker) this._updateTask(swarm, task.id, { schedulingBlocker: null });
        if (scheduled >= capacity) break;
        if (Object.keys(reserved).some((key) => demand[key] + reserved[key] > (Number(resources?.[key]) || 0))) continue;
        for (const key of Object.keys(reserved)) reserved[key] += demand[key];
        scheduled++;
        this._transition(swarm, task.id, 'queued', { error: null });
        await this._persist();
        try {
          const submitted = this.subagents.submit([taskForAgent(task, swarm.root, swarm)], swarm.id);
          const agentId = submitted.agents[0]?.id;
          if (!agentId) throw new Error('The agent scheduler did not return an agent ID');
          this._updateTask(swarm, task.id, { assignedAgentId: agentId });
          await this._persist();
          void this._watchTask(swarmId, task.id, agentId).catch(async (error) => {
            const current = this.swarms.get(swarmId);
            const found = current?.tasks.find((item) => item.id === task.id);
            if (found && !TERMINAL_TASKS.has(found.state)) {
              this._transition(current, task.id, 'failed', { error: safeError(error) });
              this._refreshStatus(current);
              await this._persist();
              await this._pump(swarmId);
            }
          });
        } catch (error) {
          this._transition(swarm, task.id, 'blocked', { error: safeError(error) });
          await this._persist();
        }
      }
      this._refreshStatus(swarm);
      await this._persist();
    } finally {
      this.schedulers.delete(swarmId);
      this.schedulerLocked = false;
      const pending = [...this.pendingPumps];
      this.pendingPumps.clear();
      for (const queuedSwarmId of pending) queueMicrotask(() => void this._pump(queuedSwarmId).catch(() => {}));
      const swarm = this.swarms.get(swarmId);
      if (swarm && SCHEDULABLE_SWARM_STATES.has(swarm.status)) {
        const graph = this._graph(swarm);
        const active = graph.list().filter((task) => ['queued', 'running'].includes(task.state)).length;
        if (active < swarm.maxConcurrency && graph.ready({ limit: 1 }).length && !this.resourcePollers.has(swarmId)) {
          const timer = setTimeout(() => {
            this.resourcePollers.delete(swarmId);
            void this._pump(swarmId).catch(() => {});
          }, 5000);
          timer.unref?.();
          this.resourcePollers.set(swarmId, timer);
        }
      }
    }
  }

  async _watchTask(swarmId, taskId, agentId) {
    while (true) {
      await this.ready;
      const swarm = this._get(swarmId);
      const task = swarm.tasks.find((item) => item.id === taskId);
      if (!task || ['cancelled', 'completed', 'failed', 'blocked', 'timed_out'].includes(task.state)) return;
      const record = this.subagents.status(agentId);
      if (record.state === 'running' && task.state === 'queued') {
        this._transition(swarm, taskId, 'running', { assignedAgentId: agentId, error: null });
        await this._persist();
      } else if (record.state === 'waiting_for_provider') {
        const result = this.subagents.result(agentId).result;
        this._transition(swarm, taskId, 'waiting_for_provider', { assignedAgentId: agentId,
          error: safeError(result?.reason || 'Model provider is unavailable'), outputs: [], artifacts: [] });
        this._refreshStatus(swarm);
        await this._persist();
        await this._pump(swarmId);
        return;
      } else if (['completed', 'failed', 'cancelled', 'timed_out'].includes(record.state)) {
        const worker = this.subagents.result(agentId);
        const result = safeResult(worker.result || { error: worker.error?.message });
        const resultState = worker.state === 'completed' && result?.status !== 'failed' && result?.status !== 'incomplete'
          ? 'completed' : worker.state === 'cancelled' ? 'cancelled' : worker.state === 'timed_out' ? 'timed_out' : 'failed';
        if (resultState === 'completed' && task.state === 'queued') this._transition(swarm, taskId, 'running', { assignedAgentId: agentId });
        const summary = safeError(result?.summary || result?.output || result?.error || 'Agent finished without a summary');
        const dependencyArtifacts = task.dependencies.map((key) => {
          const upstream = swarm.tasks.find((item) => item.key === key);
          return upstream && swarm.artifacts.findLast((item) => item.taskId === upstream.id)?.id;
        }).filter(Boolean);
        const artifact = {
          id: `artifact_${crypto.randomUUID()}`, swarmId, taskId, agentId, owner: agentId,
          type: task.mode === 'write' ? 'code_change' : 'research', summary,
          files: result?.changes?.files?.map((file) => file.path) || [],
          content: result, hash: crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'),
          dependencies: dependencyArtifacts, createdAt: new Date().toISOString(),
        };
        swarm.artifacts.push(artifact);
        this._transition(swarm, taskId, resultState, { assignedAgentId: agentId,
          error: resultState === 'completed' ? null : summary,
          outputs: [{ artifactId: artifact.id, summary }], artifacts: [artifact.id] });
        this._refreshStatus(swarm);
        if (TERMINAL_SWARMS.has(swarm.status)) swarm.completedAt ||= new Date().toISOString();
        this._emit(swarm, resultState === 'completed' ? 'agent.completed' : `agent.${resultState}`, { taskId, taskKey: task.key, agentId, artifactId: artifact.id });
        await this._persist();
        await this._pump(swarmId);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  async status(swarmId) {
    await this.ready;
    const swarm = this._get(swarmId);
    const graph = this._graph(swarm);
    const summary = graph.summary();
    return { id: swarm.id, objective: swarm.objective, root: swarm.root, status: swarm.status,
      maxConcurrency: swarm.maxConcurrency, schedulerConcurrency: this.maxConcurrency, createdAt: swarm.createdAt, updatedAt: swarm.updatedAt,
      startedAt: swarm.startedAt, completedAt: swarm.completedAt, baseline: swarm.baseline,
      tasks: summary, resourceStarvedTasks: graph.list().filter((task) => task.state === 'pending' && task.schedulingBlocker)
        .map((task) => ({ taskKey: task.key, reason: task.schedulingBlocker })),
      agents: { active: summary.counts.running, queued: summary.counts.queued, waitingForProvider: summary.counts.waiting_for_provider },
      conflicts: summary.counts.blocked, artifacts: swarm.artifacts.length, resources: this.lastResources };
  }

  async checkpoint(swarmId) {
    await this.ready;
    const swarm = this._get(swarmId);
    return clone({
      version: 1, swarmId, objective: swarm.objective, status: swarm.status, updatedAt: swarm.updatedAt,
      tasks: swarm.tasks.map((task) => ({ id: task.id, key: task.key, role: task.role, state: task.state,
        dependencies: task.dependencies, agentId: task.assignedAgentId, readScopes: task.readPaths,
        writeScopes: task.writePaths, artifacts: task.artifacts, error: task.error,
        remainingWork: ['pending', 'queued', 'running', 'waiting_for_provider', 'blocked'].includes(task.state) })),
      artifacts: swarm.artifacts.map((artifact) => ({ id: artifact.id, type: artifact.type,
        taskId: artifact.taskId, owner: artifact.owner || artifact.agentId, hash: artifact.hash || null,
        summary: artifact.summary, dependencies: artifact.dependencies || [], createdAt: artifact.createdAt })),
      messages: swarm.messages.map((message) => ({ id: message.id, fromAgentId: message.fromAgentId,
        toAgentId: message.toAgentId, type: message.type, createdAt: message.createdAt })),
      blackboardReferences: Object.entries(swarm.blackboard).map(([key, entry]) => ({ key, revision: entry.revision })),
      waitEdges: swarm.waitEdges,
      integration: swarm.tasks.filter((task) => task.mode === 'write').map((task) => ({ taskId: task.id,
        key: task.key, integratedAt: task.integratedAt || null })),
    });
  }

  async taskList(swarmId) { await this.ready; return clone(this._get(swarmId).tasks); }

  async taskStatus(swarmId, taskId) {
    await this.ready;
    const task = this._get(swarmId).tasks.find((item) => item.id === taskId || item.key === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return clone(task);
  }

  async dependencies(swarmId, taskId) {
    const task = await this.taskStatus(swarmId, taskId);
    const all = await this.taskList(swarmId);
    return { taskId: task.id, key: task.key, dependencies: task.dependencies.map((key) => all.find((item) => item.key === key)),
      dependents: all.filter((item) => item.dependencies.includes(task.key)) };
  }

  async list({ limit = 100, status } = {}) {
    await this.ready;
    const items = [...this.swarms.values()].reverse().filter((swarm) => !status || swarm.status === status).slice(0, Math.min(500, Math.max(1, limit)));
    return items.map((swarm) => ({ id: swarm.id, objective: swarm.objective, status: swarm.status, createdAt: swarm.createdAt, updatedAt: swarm.updatedAt, taskCount: swarm.tasks.length }));
  }

  async wait(swarmId, timeoutMs = 30_000) {
    await this.ready;
    const end = Date.now() + Math.max(0, Math.min(60 * 60_000, timeoutMs));
    while (Date.now() <= end) {
      const state = await this.status(swarmId);
      if (TERMINAL_SWARMS.has(state.status) || ['waiting_for_provider', 'review_required', 'paused', 'draft'].includes(state.status)) return state;
      if (Date.now() >= end) return state;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollIntervalMs, Math.max(1, end - Date.now()))));
    }
    return this.status(swarmId);
  }

  async pause(swarmId) {
    await this.ready;
    const swarm = this._get(swarmId);
    if (TERMINAL_SWARMS.has(swarm.status)) throw new Error('Cannot pause a terminal swarm');
    swarm.status = 'paused';
    this._emit(swarm, 'swarm.paused', { activeTasksContinue: true });
    await this._persist();
    return this.status(swarmId);
  }

  async resume(swarmId) {
    await this.ready;
    const swarm = this._get(swarmId);
    if (TERMINAL_SWARMS.has(swarm.status)) throw new Error('Cannot resume a terminal swarm');
    swarm.status = 'running';
    for (const task of swarm.tasks.filter((item) => item.state === 'waiting_for_provider')) {
      if (task.assignedAgentId) {
        try {
          this.subagents.orchestrator.resume(task.assignedAgentId);
          this._transition(swarm, task.id, 'queued', { error: null });
          void this._watchTask(swarmId, task.id, task.assignedAgentId).catch(() => {});
        } catch { this._transition(swarm, task.id, 'pending', { assignedAgentId: null, error: null }); }
      } else this._transition(swarm, task.id, 'pending', { error: null });
    }
    this._emit(swarm, 'swarm.resumed');
    await this._persist();
    await this._pump(swarmId);
    return this.status(swarmId);
  }

  async cancel(swarmId) {
    await this.ready;
    const swarm = this._get(swarmId);
    if (TERMINAL_SWARMS.has(swarm.status)) return this.status(swarmId);
    for (const task of swarm.tasks) {
      if (!['queued', 'running', 'waiting_for_provider', 'pending'].includes(task.state)) continue;
      if (task.assignedAgentId) {
        try { this.subagents.cancel(task.assignedAgentId); } catch { /* The executor may have already retired. */ }
      }
      if (task.state !== 'cancelled') this._transition(swarm, task.id, 'cancelled', { error: 'Swarm cancelled by the user.' });
    }
    swarm.status = 'cancelled';
    swarm.completedAt = new Date().toISOString();
    this._emit(swarm, 'swarm.cancelled');
    await this._persist();
    return this.status(swarmId);
  }

  async retryTask(swarmId, taskId) {
    await this.ready;
    const swarm = this._get(swarmId);
    if (TERMINAL_SWARMS.has(swarm.status)) throw new Error('Cannot retry a task in a terminal swarm');
    const task = await this.taskStatus(swarmId, taskId);
    if (!['failed', 'blocked', 'timed_out'].includes(task.state)) throw new Error('Only failed, blocked, or timed-out tasks can be retried');
    this._transition(swarm, task.id, 'pending', { assignedAgentId: null, startedAt: null, completedAt: null, integratedAt: null,
      error: null, retryCount: task.retryCount + 1, outputs: [], artifacts: [] });
    swarm.status = 'running';
    await this._persist();
    await this._pump(swarmId);
    return this.taskStatus(swarmId, task.id);
  }

  async review(swarmId) {
    await this.ready;
    const swarm = this._get(swarmId);
    const reports = [];
    for (const task of swarm.tasks) {
      if (!task.assignedAgentId || task.state !== 'completed') continue;
      let worker = null;
      try { worker = this.subagents.result(task.assignedAgentId); } catch { /* A completed agent record may not survive a backend restart. */ }
      const persistedArtifact = swarm.artifacts.findLast((artifact) => artifact.taskId === task.id);
      const result = worker?.result || persistedArtifact?.content || {};
      const changes = result?.changes || null;
      let review = null;
      let reviewUnavailable = false;
      if (task.mode === 'write' && changes?.files?.length) {
        try { review = await this.subagents.review(task.assignedAgentId); } catch { reviewUnavailable = true; }
      }
      reports.push({ taskId: task.id, key: task.key, role: task.role, summary: result?.summary || result?.output || '', changes,
        ...(review ? { reviewToken: review.reviewToken } : {}), ...(reviewUnavailable ? { reviewUnavailable: 'The isolated write workspace is no longer retained after restart; rerun the task to create an integratable diff.' } : {}) });
    }
    this._emit(swarm, 'swarm.reviewed', { reportCount: reports.length });
    await this._persist();
    return { swarmId, status: swarm.status, reports };
  }

  async integrate(swarmId, taskId, paths, reviewToken, verifySourceAccess) {
    await this.ready;
    const swarm = this._get(swarmId);
    const task = await this.taskStatus(swarmId, taskId);
    if (task.state !== 'completed' || task.mode !== 'write' || !task.assignedAgentId) throw new Error('A completed write task is required for integration');
    const applied = await this.subagents.apply(task.assignedAgentId, paths, reviewToken, verifySourceAccess);
    this._updateTask(swarm, task.id, { integratedAt: new Date().toISOString() });
    this._refreshStatus(swarm);
    if (swarm.status === 'completed') swarm.completedAt ||= new Date().toISOString();
    this._emit(swarm, 'integration.completed', { taskId: task.id, taskKey: task.key, applied: applied.applied });
    await this._persist();
    return { swarmId, taskId: task.id, ...applied };
  }

  async artifacts(swarmId) { await this.ready; return clone(this._get(swarmId).artifacts); }

  async artifact(swarmId, artifactId) {
    await this.ready;
    const item = this._get(swarmId).artifacts.find((artifact) => artifact.id === artifactId);
    if (!item) throw new Error(`Artifact not found: ${artifactId}`);
    return clone(item);
  }

  async events(swarmId, { afterId, limit = 100 } = {}) {
    await this.ready;
    const swarm = this._get(swarmId);
    const cursor = afterId ? swarm.events.findIndex((event) => event.id === afterId) : -1;
    const filtered = swarm.events.slice(cursor + 1);
    return { swarmId, events: clone(filtered.slice(-Math.min(500, Math.max(1, limit)))), truncated: filtered.length > limit };
  }

  _agentTask(swarmId, agentId, taskId) {
    const swarm = this._get(swarmId);
    const task = swarm.tasks.find((item) => item.id === taskId && item.assignedAgentId === agentId);
    if (!task) throw new Error('Agent is not assigned to this task in the requested swarm');
    return { swarm, task };
  }

  async sendAgentMessage({ swarmId, fromAgentId, toAgentId = null, type = 'STATUS', priority = 'NORMAL', payload } = {}) {
    await this.ready;
    const swarm = this._get(swarmId);
    if (fromAgentId !== 'supervisor' && !swarm.tasks.some((task) => task.assignedAgentId === fromAgentId)) throw new Error('Sender must be an agent in this swarm');
    if (!MESSAGE_TYPES.has(type)) throw new Error(`Unsupported agent message type: ${type}`);
    if (!['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(priority)) throw new Error('Message priority must be LOW, NORMAL, HIGH, or URGENT');
    if (toAgentId !== null && toAgentId !== '*') {
      if (!swarm.tasks.some((task) => task.assignedAgentId === toAgentId)) throw new Error('Message recipient must be an agent in this swarm');
    }
    const body = boundedJson(payload, 'message payload');
    const message = { id: `message_${crypto.randomUUID()}`, fromAgentId, toAgentId, swarmId, type, payload: body,
      timestamp: new Date().toISOString(), priority, acknowledged: false, acknowledgedBy: null, acknowledgedAt: null };
    swarm.messages.push(message);
    if (swarm.messages.length > MAX_MESSAGE_COUNT) swarm.messages.splice(0, swarm.messages.length - MAX_MESSAGE_COUNT);
    if (Buffer.byteLength(JSON.stringify(swarm.messages), 'utf8') > MAX_SHARED_DATA_BYTES) {
      swarm.messages.pop();
      throw new RangeError('Swarm message history exceeds the 2 MiB limit');
    }
    this._emit(swarm, 'message.sent', { messageId: message.id, fromAgentId, toAgentId: toAgentId || '*', messageType: type, priority });
    await this._persist();
    return clone(message);
  }

  async agentMessages(swarmId, agentId, { limit = 100, afterId } = {}) {
    await this.ready;
    const swarm = this._get(swarmId);
    if (!swarm.tasks.some((task) => task.assignedAgentId === agentId)) throw new Error('Agent is not part of this swarm');
    const cursor = afterId ? swarm.messages.findIndex((message) => message.id === afterId) : -1;
    const messages = swarm.messages.slice(cursor + 1).filter((message) => message.fromAgentId === agentId || message.toAgentId === agentId || message.toAgentId === null || message.toAgentId === '*');
    return { swarmId, agentId, messages: clone(messages.slice(-Math.min(500, Math.max(1, limit)))), truncated: messages.length > limit };
  }

  async acknowledgeAgentMessage(swarmId, agentId, messageId) {
    await this.ready;
    const swarm = this._get(swarmId);
    if (!swarm.tasks.some((task) => task.assignedAgentId === agentId)) throw new Error('Agent is not part of this swarm');
    const message = swarm.messages.find((item) => item.id === messageId);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    if (message.toAgentId !== agentId && message.toAgentId !== null && message.toAgentId !== '*') throw new Error('Only the addressed agent can acknowledge this message');
    message.acknowledged = true;
    message.acknowledgedBy = agentId;
    message.acknowledgedAt = new Date().toISOString();
    this._emit(swarm, 'message.acknowledged', { messageId, agentId });
    await this._persist();
    return clone(message);
  }

  _waitPath(swarm, fromAgentId, targetAgentId) {
    const queue = [[fromAgentId, []]];
    const visited = new Set([fromAgentId]);
    while (queue.length) {
      const [current, pathEdges] = queue.shift();
      if (current === targetAgentId) return pathEdges;
      for (const edge of swarm.waitEdges) {
        if (edge.fromAgentId !== current || visited.has(edge.toAgentId)) continue;
        visited.add(edge.toAgentId);
        queue.push([edge.toAgentId, [...pathEdges, edge]]);
      }
    }
    return null;
  }

  async agentWaitFor({ swarmId, agentId, taskId, targetAgentId, reason = '' } = {}) {
    await this.ready;
    const swarm = this._get(swarmId);
    const source = this._agentTask(swarmId, agentId, taskId).task;
    if (!['queued', 'running'].includes(source.state)) throw new Error('Only an active agent can register a wait');
    if (typeof targetAgentId !== 'string' || !targetAgentId || targetAgentId === agentId) throw new Error('A different target agent ID is required');
    const target = swarm.tasks.find((item) => item.assignedAgentId === targetAgentId);
    if (!target || !['queued', 'running'].includes(target.state)) throw new Error('Wait target must be an active agent in the same swarm');
    if (typeof reason !== 'string' || reason.length > 1000) throw new Error('Wait reason must be at most 1,000 characters');
    reason = boundedJson(reason, 'wait reason', 1000);
    const existing = swarm.waitEdges.find((edge) => edge.fromAgentId === agentId && edge.toAgentId === targetAgentId);
    const edge = existing || { fromAgentId: agentId, fromTaskId: taskId, toAgentId: targetAgentId, toTaskId: target.id,
      createdAt: new Date().toISOString() };
    edge.reason = reason;
    edge.updatedAt = new Date().toISOString();
    const returnPath = this._waitPath(swarm, targetAgentId, agentId);
    if (returnPath) {
      const cycleEdges = [...returnPath, edge];
      const cycleAgentIds = [agentId, targetAgentId, ...returnPath.map((item) => item.toAgentId)];
      const deadlock = { id: `deadlock_${crypto.randomUUID()}`, swarmId, detectedAt: new Date().toISOString(),
        cycleAgentIds, edges: cycleEdges.map(({ fromAgentId, toAgentId, fromTaskId, toTaskId, reason: edgeReason }) => ({ fromAgentId, toAgentId, fromTaskId, toTaskId, reason: edgeReason })),
        resolved: false, escalated: true };
      swarm.deadlocks.push(deadlock);
      if (swarm.deadlocks.length > MAX_DEADLOCK_RECORDS) swarm.deadlocks.splice(0, swarm.deadlocks.length - MAX_DEADLOCK_RECORDS);
      this._emit(swarm, 'deadlock.detected', { deadlockId: deadlock.id, cycleAgentIds });
      await this._persist();
      return { detected: true, escalated: true, deadlock: clone(deadlock), guidance: 'Stop waiting on the cycle and report this deadlock to the swarm supervisor.' };
    }
    if (!existing) {
      if (swarm.waitEdges.length >= MAX_WAIT_EDGES) throw new Error(`Swarm wait graph is limited to ${MAX_WAIT_EDGES} edges`);
      swarm.waitEdges.push(edge);
    }
    this._emit(swarm, 'agent.wait_registered', { fromAgentId: agentId, toAgentId: targetAgentId, taskId });
    await this._persist();
    return { detected: false, edge: clone(edge), waitGraph: clone(swarm.waitEdges) };
  }

  async agentWaitClear({ swarmId, agentId, taskId, targetAgentId = null } = {}) {
    await this.ready;
    const swarm = this._get(swarmId);
    this._agentTask(swarmId, agentId, taskId);
    if (targetAgentId !== null && typeof targetAgentId !== 'string') throw new Error('targetAgentId must be an agent ID or null');
    const before = swarm.waitEdges.length;
    swarm.waitEdges = swarm.waitEdges.filter((edge) => edge.fromAgentId !== agentId || (targetAgentId !== null && edge.toAgentId !== targetAgentId));
    const cleared = before - swarm.waitEdges.length;
    if (cleared) {
      this._resolveDeadlocks(swarm, 'An agent cleared a wait edge in the detected cycle.');
      this._emit(swarm, 'agent.wait_cleared', { agentId, taskId, targetAgentId, cleared });
      await this._persist();
    }
    return { swarmId, agentId, cleared, waitGraph: clone(swarm.waitEdges) };
  }

  async waitGraph(swarmId) {
    await this.ready;
    const swarm = this._get(swarmId);
    return { swarmId, edges: clone(swarm.waitEdges), deadlocks: clone(swarm.deadlocks),
      activeDeadlocks: swarm.deadlocks.filter((item) => !item.resolved).length };
  }

  async blackboardRead(swarmId, key, { agentId, taskId } = {}) {
    await this.ready;
    validateBlackboardKey(key);
    const swarm = this._get(swarmId);
    if (agentId) {
      const { task } = this._agentTask(swarmId, agentId, taskId);
      if (!task.blackboardReadKeys.includes(key) && !task.blackboardWriteKeys.includes(key)) throw new Error(`Blackboard read is not granted for key: ${key}`);
    }
    return clone(swarm.blackboard[key] || null);
  }

  async blackboardWrite(swarmId, key, value, { agentId, taskId, expectedRevision = null } = {}) {
    await this.ready;
    validateBlackboardKey(key);
    const swarm = this._get(swarmId);
    let actor = 'supervisor';
    if (agentId) {
      const { task } = this._agentTask(swarmId, agentId, taskId);
      if (!task.blackboardWriteKeys.includes(key)) throw new Error(`Blackboard write is not granted for key: ${key}`);
      actor = agentId;
    }
    const existing = swarm.blackboard[key] || null;
    if (expectedRevision !== null && expectedRevision !== (existing?.revision ?? 0)) throw new Error('Blackboard revision conflict; read the latest value before writing');
    if (expectedRevision === null && existing) throw new Error('Blackboard key exists; provide its current revision to update it');
    if (!existing && Object.keys(swarm.blackboard).length >= MAX_BLACKBOARD_KEYS) throw new Error(`Blackboard is limited to ${MAX_BLACKBOARD_KEYS} keys`);
    const safeValue = boundedJson(value, 'blackboard value');
    const revision = (existing?.revision || 0) + 1;
    swarm.blackboard[key] = { value: safeValue, revision, updatedAt: new Date().toISOString(), updatedBy: actor };
    if (Buffer.byteLength(JSON.stringify(swarm.blackboard), 'utf8') > MAX_SHARED_DATA_BYTES) {
      if (existing) swarm.blackboard[key] = existing; else delete swarm.blackboard[key];
      throw new RangeError('Swarm blackboard exceeds the 2 MiB limit');
    }
    this._emit(swarm, 'blackboard.updated', { key, revision, updatedBy: actor });
    await this._persist();
    return clone(swarm.blackboard[key]);
  }

  async agentMemoryRead(swarmId, agentId, taskId, scope, key) {
    await this.ready;
    const { swarm, task } = this._agentTask(swarmId, agentId, taskId);
    if (!['agent', 'task'].includes(scope)) throw new Error('Memory scope must be agent or task');
    const owner = scope === 'agent' ? agentId : task.id;
    const item = swarm.memory.find((entry) => entry.scope === scope && entry.owner === owner && entry.key === validateBlackboardKey(key));
    return clone(item || null);
  }

  async agentMemoryWrite(swarmId, agentId, taskId, scope, key, value) {
    await this.ready;
    const { swarm, task } = this._agentTask(swarmId, agentId, taskId);
    if (!['agent', 'task'].includes(scope)) throw new Error('Memory scope must be agent or task');
    const owner = scope === 'agent' ? agentId : task.id;
    key = validateBlackboardKey(key);
    const safeValue = boundedJson(value, 'agent memory value');
    let item = swarm.memory.find((entry) => entry.scope === scope && entry.owner === owner && entry.key === key);
    if (!item && swarm.memory.length >= MAX_AGENT_MEMORY_ENTRIES) throw new Error(`Agent memory is limited to ${MAX_AGENT_MEMORY_ENTRIES} entries per swarm`);
    const oldItem = item ? clone(item) : null;
    if (!item) { item = { scope, owner, key, revision: 0, createdAt: new Date().toISOString() }; swarm.memory.push(item); }
    item.value = safeValue;
    item.revision++;
    item.updatedAt = new Date().toISOString();
    if (Buffer.byteLength(JSON.stringify(swarm.memory), 'utf8') > MAX_SHARED_DATA_BYTES) {
      if (oldItem) Object.assign(item, oldItem); else swarm.memory.pop();
      throw new RangeError('Agent memory exceeds the 2 MiB limit');
    }
    this._emit(swarm, 'memory.updated', { scope, owner, key, revision: item.revision });
    await this._persist();
    return clone(item);
  }

  async spawnChildAgent({ swarmId, parentAgentId, parentTaskId, child } = {}) {
    await this.ready;
    const swarm = this._get(swarmId);
    if (swarm.status !== 'running') throw new Error('Child agents can only be spawned by an active swarm');
    const parent = swarm.tasks.find((task) => task.id === parentTaskId && task.assignedAgentId === parentAgentId);
    if (!parent || !['queued', 'running'].includes(parent.state)) throw new Error('Parent agent is not currently active in this swarm');
    if (parent.spawnDepth >= 3) throw new Error('Agent hierarchy is limited to three child levels');
    if (swarm.tasks.filter((task) => task.parentTaskKey === parent.key).length >= 3) throw new Error('Each agent may spawn at most three child agents');
    if (!child || child.mode && child.mode !== 'read') throw new Error('Dynamically spawned children are read-only and inherit no write access');
    if (!Array.isArray(child.readPaths) || !child.readPaths.length) throw new Error('Child agents require explicit, least-privilege read paths');
    if (child.processAccess === true && !parent.processAccess) throw new Error('Child process access must be inherited from a parent that has the same grant');
    const requestedReads = child.readPaths;
    for (const requested of requestedReads) {
      const target = strictRelative(swarm.root, requested);
      let coveredByParent = false;
      for (const scope of parent.readPaths) {
        const parentPath = strictRelative(swarm.root, scope);
        if (target === parentPath) { coveredByParent = true; break; }
        try { if ((await fs.stat(parentPath)).isDirectory() && within(parentPath, target)) { coveredByParent = true; break; } }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      }
      if (!coveredByParent) throw new Error(`Child read scope exceeds parent capability: ${requested}`);
    }
    const childReads = child.blackboardReadKeys || [];
    const childWrites = child.blackboardWriteKeys || [];
    if (childReads.some((key) => !parent.blackboardReadKeys.includes(key) && !parent.blackboardWriteKeys.includes(key))) throw new Error('Child blackboard read grants must be inherited from the parent');
    if (childWrites.some((key) => !parent.blackboardWriteKeys.includes(key))) throw new Error('Child blackboard write grants must be inherited from the parent');
    const input = { ...child, mode: 'read', readPaths: requestedReads, writePaths: [], provider: child.provider || parent.provider,
      processAccess: child.processAccess === true,
      model: child.model || parent.model, blackboardReadKeys: childReads, blackboardWriteKeys: childWrites,
      parentTaskKey: parent.key, spawnDepth: parent.spawnDepth + 1 };
    await this.plan(swarmId, [input]);
    const spawned = await this.taskStatus(swarmId, input.key);
    this._emit(swarm, 'agent.child_spawned', { taskId: spawned.id, taskKey: spawned.key, parentTaskId, parentAgentId });
    await this._persist();
    return { swarmId, parentAgentId, parentTaskId, taskId: spawned.id, taskKey: spawned.key, agentId: spawned.assignedAgentId, state: spawned.state };
  }

  createAgentTools({ swarmId, taskId, agentId } = {}) {
    const swarm = this.swarms.get(swarmId);
    const task = swarm?.tasks.find((item) => item.id === taskId && item.assignedAgentId === agentId);
    if (!task) throw new Error('Cannot create swarm tools for an unassigned worker');
    const readKeys = [...new Set([...task.blackboardReadKeys, ...task.blackboardWriteKeys])];
    const specs = [
      agentFunction('agent_message_send', 'Send a bounded structured message to one agent or broadcast it within this swarm.', {
        toAgentId: { type: ['string', 'null'], description: 'Recipient agent ID, or null to broadcast within this swarm' },
        messageType: { type: 'string', enum: [...MESSAGE_TYPES] },
        priority: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
        payload: { type: 'object', description: 'JSON payload up to 16 KiB; do not include secrets', additionalProperties: true },
      }),
      agentFunction('agent_message_list', 'Read only messages addressed to this agent, broadcast messages, and messages it sent.', {}),
      agentFunction('agent_message_ack', 'Acknowledge a message addressed to this agent.', { messageId: { type: 'string' } }),
      agentFunction('agent_wait_for', 'Declare that this active agent is waiting for another active agent; ForgeLink detects cycles and escalates them to the supervisor.', {
        targetAgentId: { type: 'string' }, reason: { type: 'string', description: 'Why progress depends on this agent; at most 1,000 characters.' },
      }),
      agentFunction('agent_wait_clear', 'Clear one wait edge after its dependency is handled, or clear all of this agent’s waits.', {
        targetAgentId: { type: ['string', 'null'], description: 'Agent ID to clear, or null to clear every outgoing wait edge.' },
      }),
      agentFunction('agent_memory_read', 'Read this agent or task scoped memory entry.', { scope: { type: 'string', enum: ['agent', 'task'] }, key: { type: 'string' } }),
      agentFunction('agent_memory_write', 'Write a bounded private agent or task memory entry.', { scope: { type: 'string', enum: ['agent', 'task'] }, key: { type: 'string' }, value: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] } }),
    ];
    if (readKeys.length) specs.push(agentFunction('swarm_blackboard_read', 'Read one explicitly granted shared swarm key; the full blackboard is never injected into context.', { key: { type: 'string', enum: readKeys } }));
    if (task.blackboardWriteKeys.length) specs.push(agentFunction('swarm_blackboard_write', 'Write one explicitly granted shared swarm key using revision compare-and-set.', {
      key: { type: 'string', enum: task.blackboardWriteKeys },
      value: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] },
      expectedRevision: { type: ['integer', 'null'], description: 'Current revision; null creates a missing key only' },
    }));
    if (task.spawnDepth < 3 && swarm.tasks.filter((item) => item.parentTaskKey === task.key).length < 3) specs.push(agentFunction('agent_spawn_child', 'Spawn a bounded read-only child agent with a subset of your read and blackboard capabilities.', {
      key: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' }, role: { type: ['string', 'null'] },
      readPaths: { type: 'array', items: { type: 'string' } }, priority: { type: 'string', enum: [...TASK_PRIORITIES] },
      processAccess: { type: 'boolean', description: 'True only if your own task has process access and the child needs it.' },
      blackboardReadKeys: { type: 'array', items: { type: 'string', enum: [...readKeys] } },
      blackboardWriteKeys: { type: 'array', items: { type: 'string', enum: task.blackboardWriteKeys } },
    }));
    return { specs, execute: async (name, args) => {
      if (name === 'agent_message_send') return await this.sendAgentMessage({ swarmId, fromAgentId: agentId,
        toAgentId: args.toAgentId, type: args.messageType, priority: args.priority, payload: args.payload });
      if (name === 'agent_message_list') return await this.agentMessages(swarmId, agentId, { limit: 100 });
      if (name === 'agent_message_ack') return await this.acknowledgeAgentMessage(swarmId, agentId, args.messageId);
      if (name === 'agent_wait_for') return await this.agentWaitFor({ swarmId, agentId, taskId, targetAgentId: args.targetAgentId, reason: args.reason });
      if (name === 'agent_wait_clear') return await this.agentWaitClear({ swarmId, agentId, taskId, targetAgentId: args.targetAgentId });
      if (name === 'swarm_blackboard_read') return await this.blackboardRead(swarmId, args.key, { agentId, taskId });
      if (name === 'swarm_blackboard_write') return await this.blackboardWrite(swarmId, args.key, args.value,
        { agentId, taskId, expectedRevision: args.expectedRevision });
      if (name === 'agent_memory_read') return await this.agentMemoryRead(swarmId, agentId, taskId, args.scope, args.key);
      if (name === 'agent_memory_write') return await this.agentMemoryWrite(swarmId, agentId, taskId, args.scope, args.key, args.value);
      if (name === 'agent_spawn_child') return await this.spawnChildAgent({ swarmId, parentAgentId: agentId, parentTaskId: taskId,
        child: { ...args, mode: 'read' } });
      throw new Error(`Unknown swarm-agent tool: ${name}`);
    } };
  }

  async agentList(swarmId) {
    const tasks = await this.taskList(swarmId);
    return tasks.filter((task) => task.assignedAgentId).map((task) => ({ id: task.assignedAgentId, taskId: task.id, taskKey: task.key, role: task.role, state: task.state }));
  }

  async agentStatus(swarmId, agentId) {
    await this.ready;
    const swarm = this._get(swarmId);
    const task = swarm.tasks.find((item) => item.assignedAgentId === agentId);
    if (!task) throw new Error(`Agent not found in swarm: ${agentId}`);
    let execution;
    let result;
    try { execution = this.subagents.status(agentId); } catch { execution = { state: 'record_unavailable_after_restart' }; }
    try { result = task.state === 'completed' ? this.subagents.result(agentId) : undefined; } catch {
      result = swarm.artifacts.find((artifact) => artifact.taskId === task.id)?.content;
    }
    return { agentId, taskId: task.id, role: task.role, state: task.state, error: task.error, execution, result };
  }

  async cancelAgent(swarmId, agentId) {
    await this.ready;
    const swarm = this._get(swarmId);
    const task = swarm.tasks.find((item) => item.assignedAgentId === agentId);
    if (!task) throw new Error(`Agent not found in swarm: ${agentId}`);
    this.subagents.cancel(agentId);
    if (!TERMINAL_TASKS.has(task.state)) this._transition(swarm, task.id, 'cancelled', { error: 'Agent cancelled by the supervisor.' });
    await this._persist();
    await this._pump(swarmId);
    return { swarmId, agentId, taskId: task.id, state: task.state };
  }
}

export { defaultConcurrency as defaultAgentConcurrency };
