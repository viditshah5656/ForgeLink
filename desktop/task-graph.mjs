import crypto from 'node:crypto';

export const TASK_PRIORITIES = Object.freeze(['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND']);
export const TASK_STATES = Object.freeze(['pending', 'queued', 'running', 'waiting_for_provider', 'blocked', 'completed', 'failed', 'cancelled', 'timed_out']);

const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(['queued', 'blocked', 'cancelled']),
  queued: new Set(['pending', 'running', 'waiting_for_provider', 'blocked', 'failed', 'cancelled', 'timed_out']),
  running: new Set(['pending', 'waiting_for_provider', 'blocked', 'completed', 'failed', 'cancelled', 'timed_out']),
  waiting_for_provider: new Set(['pending', 'queued', 'cancelled', 'failed']),
  blocked: new Set(['pending', 'cancelled']),
  completed: new Set(), failed: new Set(['pending']), cancelled: new Set(), timed_out: new Set(['pending']),
});

function requireText(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new TypeError(`${name} must be a nonempty string of at most ${maximum} characters`);
  return value.trim();
}

function normalizeTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Each task must be an object');
  const key = requireText(input.key, 'task.key', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) throw new TypeError(`Invalid task key: ${key}`);
  const priority = String(input.priority || 'NORMAL').toUpperCase();
  if (!TASK_PRIORITIES.includes(priority)) throw new TypeError(`Invalid priority for task ${key}`);
  const dependencies = input.dependencies || [];
  if (!Array.isArray(dependencies) || dependencies.length > 100 || dependencies.some((item) => typeof item !== 'string')) throw new TypeError(`Invalid dependencies for task ${key}`);
  const uniqueDependencies = [...new Set(dependencies)];
  if (uniqueDependencies.includes(key)) throw new Error(`Task ${key} cannot depend on itself`);
  const state = input.state || 'pending';
  if (!TASK_STATES.includes(state)) throw new TypeError(`Invalid task state for ${key}`);
  return {
    id: input.id || crypto.randomUUID(), key,
    title: requireText(input.title || key, 'task.title', 200),
    description: typeof input.description === 'string' ? input.description.slice(0, 20_000) : '',
    prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 20_000) : '',
    role: typeof input.role === 'string' ? input.role.slice(0, 120) : 'Specialist',
    label: typeof input.label === 'string' ? input.label.slice(0, 200) : '',
    mode: input.mode === 'write' ? 'write' : 'read',
    readPaths: Array.isArray(input.readPaths) ? structuredClone(input.readPaths).slice(0, 50) : ['.'],
    writePaths: Array.isArray(input.writePaths) ? structuredClone(input.writePaths).slice(0, 50) : [],
    provider: typeof input.provider === 'string' ? input.provider : 'native',
    processAccess: input.processAccess === true,
    model: typeof input.model === 'string' ? input.model.slice(0, 100) : undefined,
    reasoning: input.reasoning && typeof input.reasoning === 'object' ? structuredClone(input.reasoning) : { mode: 'default' },
    maxTurns: Number.isInteger(input.maxTurns) ? Math.max(1, Math.min(40, input.maxTurns)) : 12,
    maxOutputTokens: Number.isInteger(input.maxOutputTokens) ? Math.max(256, Math.min(16_000, input.maxOutputTokens)) : 4096,
    timeoutMs: Number.isInteger(input.timeoutMs) ? Math.max(1000, Math.min(60 * 60_000, input.timeoutMs)) : 600_000,
    priority,
    dependencies: uniqueDependencies,
    parentTaskKey: typeof input.parentTaskKey === 'string' ? input.parentTaskKey.slice(0, 64) : null,
    spawnDepth: Number.isInteger(input.spawnDepth) ? Math.max(0, Math.min(3, input.spawnDepth)) : 0,
    blackboardReadKeys: Array.isArray(input.blackboardReadKeys) ? [...new Set(input.blackboardReadKeys)].slice(0, 50) : [],
    blackboardWriteKeys: Array.isArray(input.blackboardWriteKeys) ? [...new Set(input.blackboardWriteKeys)].slice(0, 50) : [],
    state,
    assignedAgentId: input.assignedAgentId || null,
    retryCount: Number.isInteger(input.retryCount) ? Math.max(0, input.retryCount) : 0,
    schedulingBlocker: input.schedulingBlocker ? String(input.schedulingBlocker).slice(0, 500) : null,
    resourceRequirements: {
      cpu: Number.isInteger(input.resourceRequirements?.cpu) ? Math.max(1, Math.min(64, input.resourceRequirements.cpu)) : 1,
      ram_mb: Number.isInteger(input.resourceRequirements?.ram_mb) ? Math.max(0, Math.min(1_048_576, input.resourceRequirements.ram_mb)) : 512,
      vram_mb: Number.isInteger(input.resourceRequirements?.vram_mb) ? Math.max(0, Math.min(1_048_576, input.resourceRequirements.vram_mb)) : 0,
      processes: Number.isInteger(input.resourceRequirements?.processes) ? Math.max(0, Math.min(128, input.resourceRequirements.processes)) : input.processAccess === true ? 1 : 0,
    },
    inputs: Array.isArray(input.inputs) ? structuredClone(input.inputs).slice(0, 100) : [],
    outputs: Array.isArray(input.outputs) ? structuredClone(input.outputs).slice(0, 100) : [],
    artifacts: Array.isArray(input.artifacts) ? structuredClone(input.artifacts).slice(0, 100) : [],
    error: input.error ? String(input.error).slice(0, 2000) : null,
    createdAt: input.createdAt || new Date().toISOString(),
    startedAt: input.startedAt || null,
    completedAt: input.completedAt || null,
    integratedAt: input.integratedAt || null,
  };
}

/** Validated in-memory DAG. Execution and durable storage belong to the manager. */
export class TaskGraph {
  constructor(tasks = []) {
    if (!Array.isArray(tasks) || tasks.length > 1000) throw new RangeError('A task graph may contain at most 1000 tasks');
    this.tasks = new Map();
    this.byKey = new Map();
    for (const input of tasks) {
      const task = normalizeTask(input);
      if (this.tasks.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
      if (this.byKey.has(task.key)) throw new Error(`Duplicate task key: ${task.key}`);
      this.tasks.set(task.id, task);
      this.byKey.set(task.key, task.id);
    }
    this.validate();
  }

  validate() {
    for (const task of this.tasks.values()) {
      for (const dependency of task.dependencies) {
        if (!this.byKey.has(dependency)) throw new Error(`Task ${task.key} references unknown dependency ${dependency}`);
      }
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (key, chain) => {
      if (visiting.has(key)) throw new Error(`Task dependency cycle: ${[...chain, key].join(' -> ')}`);
      if (visited.has(key)) return;
      visiting.add(key);
      const task = this.getByKey(key);
      for (const dependency of task.dependencies) visit(dependency, [...chain, key]);
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of this.byKey.keys()) visit(key, []);
    return true;
  }

  add(tasks) {
    if (!Array.isArray(tasks) || this.tasks.size + tasks.length > 1000) throw new RangeError('Task graph limit exceeded');
    const snapshot = [...this.tasks.values()].map((task) => structuredClone(task));
    try {
      const added = tasks.map(normalizeTask);
      for (const task of added) {
        if (this.tasks.has(task.id) || this.byKey.has(task.key)) throw new Error(`Duplicate task key or id: ${task.key}`);
        this.tasks.set(task.id, task);
        this.byKey.set(task.key, task.id);
      }
      this.validate();
      return added.map((task) => structuredClone(task));
    } catch (error) {
      this.tasks = new Map(snapshot.map((task) => [task.id, task]));
      this.byKey = new Map(snapshot.map((task) => [task.key, task.id]));
      throw error;
    }
  }

  get(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return structuredClone(task);
  }

  getByKey(key) {
    const id = this.byKey.get(key);
    if (!id) throw new Error(`Task not found: ${key}`);
    return this.tasks.get(id);
  }

  transition(id, next, patch = {}) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (!TASK_STATES.includes(next) || !ALLOWED_TRANSITIONS[task.state].has(next)) throw new Error(`Invalid task transition: ${task.state} -> ${next}`);
    const mutableFields = new Set(['assignedAgentId', 'retryCount', 'inputs', 'outputs', 'artifacts', 'error', 'schedulingBlocker', 'startedAt', 'completedAt', 'integratedAt']);
    for (const key of Object.keys(patch)) if (!mutableFields.has(key)) throw new Error(`Task field cannot be changed by a transition: ${key}`);
    task.state = next;
    Object.assign(task, structuredClone(patch));
    if (next === 'running' && !task.startedAt) task.startedAt = new Date().toISOString();
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(next)) task.completedAt = new Date().toISOString();
    return structuredClone(task);
  }

  update(id, patch = {}) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const mutableFields = new Set(['assignedAgentId', 'retryCount', 'inputs', 'outputs', 'artifacts', 'error', 'schedulingBlocker', 'startedAt', 'completedAt', 'integratedAt']);
    for (const key of Object.keys(patch)) if (!mutableFields.has(key)) throw new Error(`Task field cannot be changed: ${key}`);
    Object.assign(task, structuredClone(patch));
    return structuredClone(task);
  }

  ready({ limit = 100 } = {}) {
    const rank = new Map(TASK_PRIORITIES.map((priority, index) => [priority, index]));
    return [...this.tasks.values()]
      .filter((task) => task.state === 'pending' && task.dependencies.every((key) => this.getByKey(key).state === 'completed'))
      .sort((a, b) => rank.get(a.priority) - rank.get(b.priority) || a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit).map((task) => structuredClone(task));
  }

  blockedByFailure() {
    return [...this.tasks.values()].filter((task) => task.state === 'pending'
      && task.dependencies.some((key) => ['failed', 'cancelled', 'blocked', 'timed_out'].includes(this.getByKey(key).state)))
      .map((task) => structuredClone(task));
  }

  list() { return [...this.tasks.values()].map((task) => structuredClone(task)); }

  summary() {
    const counts = Object.fromEntries(TASK_STATES.map((state) => [state, 0]));
    for (const task of this.tasks.values()) counts[task.state]++;
    return { total: this.tasks.size, counts, ready: this.ready().length, blockedByFailure: this.blockedByFailure().length,
      resourceStarved: [...this.tasks.values()].filter((task) => task.state === 'pending' && task.schedulingBlocker).length };
  }
}
