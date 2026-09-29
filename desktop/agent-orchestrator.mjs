import crypto from 'node:crypto';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const RESULT_STATES = new Set([...TERMINAL, 'waiting_for_provider']);
const MAX_CONCURRENCY = 64;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_HEARTBEAT_LIFETIME_MS = 30 * 60_000;

function integerInRange(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function jsonCopy(value, name, maxBytes = MAX_PAYLOAD_BYTES) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new TypeError(`${name} must be JSON serializable`); }
  if (encoded === undefined) throw new TypeError(`${name} must be JSON serializable`);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new RangeError(`${name} exceeds ${maxBytes} bytes`);
  return JSON.parse(encoded);
}

function errorSummary(error) {
  if (error instanceof Error) return { name: error.name, message: error.message.slice(0, 2000) };
  let message;
  try { message = String(error); } catch { message = 'Unknown work unit failure'; }
  return { name: 'Error', message: message.slice(0, 2000) };
}

/**
 * A bounded, in-process scheduler for independent agent work units. The caller
 * supplies execute(workUnit, signal, context); this module neither selects a
 * model nor starts processes. The execute implementation must honor abort to
 * free an occupied slot after cancellation or timeout.
 */
export class AgentOrchestrator {
  constructor({
    execute,
    concurrency = 12,
    maxQueued = 200,
    maxRecords = 1000,
    defaultTimeoutMs = 300000,
    maxHeartbeatLifetimeMs = DEFAULT_HEARTBEAT_LIFETIME_MS,
    onEvent = () => {},
  } = {}) {
    if (typeof execute !== 'function') throw new TypeError('execute(workUnit, signal, context) is required');
    if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
    this.execute = execute;
    this.concurrency = integerInRange(concurrency, 'concurrency', 1, MAX_CONCURRENCY);
    this.maxQueued = integerInRange(maxQueued, 'maxQueued', 1, 10000);
    this.maxRecords = integerInRange(maxRecords, 'maxRecords', 1, 100000);
    this.defaultTimeoutMs = integerInRange(defaultTimeoutMs, 'defaultTimeoutMs', 1, 3600000);
    this.maxHeartbeatLifetimeMs = integerInRange(maxHeartbeatLifetimeMs, 'maxHeartbeatLifetimeMs', 1, 3600000);
    this.onEvent = onEvent;
    this.records = new Map();
    this.groupQueues = new Map();
    this.groupOrder = [];
    this.queued = 0;
    this.occupied = 0;
    this.nextEventId = 1;
    this.events = [];
    this.drainScheduled = false;
    this.closed = false;
  }

  _snapshot(record, includeResult = false) {
    const out = {
      id: record.id,
      groupId: record.groupId,
      label: record.label,
      state: record.state,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      timeoutMs: record.timeoutMs,
      workerActive: record.workerActive,
      metadata: jsonCopy(record.metadata, 'metadata'),
    };
    if (includeResult && RESULT_STATES.has(record.state)) {
      if (record.result !== undefined) out.result = jsonCopy(record.result, 'result');
      if (record.error) out.error = { ...record.error };
    }
    return out;
  }

  _emit(type, record) {
    const event = { eventId: this.nextEventId++, at: new Date().toISOString(), type, ...this._snapshot(record) };
    this.events.push(event);
    if (this.events.length > 1000) this.events.shift();
    try { this.onEvent(jsonCopy(event, 'event')); } catch { /* Observers cannot stop scheduling. */ }
    if (type === 'waiting_for_provider') {
      const snapshot = this._snapshot(record, true);
      for (const resolve of record.providerWaiters) resolve(snapshot);
      record.providerWaiters.clear();
    }
  }

  _validate(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new TypeError('work unit specification must be an object');
    const groupId = spec.groupId ?? 'default';
    const label = spec.label ?? '';
    if (typeof groupId !== 'string' || !groupId.trim() || groupId.length > 128) throw new TypeError('groupId must be a nonempty string of at most 128 characters');
    if (typeof label !== 'string' || label.length > 200) throw new TypeError('label must be a string of at most 200 characters');
    const timeoutMs = integerInRange(spec.timeoutMs ?? this.defaultTimeoutMs, 'timeoutMs', 1, 3600000);
    const workUnit = jsonCopy(spec.workUnit, 'workUnit');
    const metadata = jsonCopy(spec.metadata ?? {}, 'metadata', 4096);
    return { groupId, label, timeoutMs, workUnit, metadata };
  }

  submit(spec) {
    return this.submitBatch([spec])[0];
  }

  /** Validates and enqueues the whole batch atomically. */
  submitBatch(specs) {
    if (this.closed) throw new Error('Orchestrator is closed');
    if (!Array.isArray(specs) || specs.length < 1 || specs.length > this.maxQueued) throw new RangeError('batch size must fit the queue limit');
    const validated = specs.map((spec) => this._validate(spec));
    if (this.queued + validated.length > this.maxQueued) throw new Error(`Queue is full (maximum ${this.maxQueued})`);
    const created = validated.map((value) => {
      const record = {
        ...value, id: crypto.randomUUID(), state: 'queued',
        createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
        workerActive: false, result: undefined, error: null, controller: null,
        timer: null, deadlineAt: null, hardDeadlineAt: null, resolveDone: null, done: null,
        providerWaiters: new Set(),
      };
      record.done = new Promise((resolve) => { record.resolveDone = resolve; });
      return record;
    });
    for (const record of created) {
      this.records.set(record.id, record);
      if (!this.groupQueues.has(record.groupId)) {
        this.groupQueues.set(record.groupId, []);
        this.groupOrder.push(record.groupId);
      }
      this.groupQueues.get(record.groupId).push(record.id);
      this.queued++;
    }
    for (const record of created) this._emit('queued', record);
    this._scheduleDrain();
    this._prune();
    return created.map((record) => this._snapshot(record));
  }

  _scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      while (this.occupied < this.concurrency && this.queued > 0) {
        const record = this._dequeueFair();
        if (!record) break;
        this._start(record);
      }
    });
  }

  _dequeueFair() {
    while (this.groupOrder.length) {
      const groupId = this.groupOrder.shift();
      const queue = this.groupQueues.get(groupId);
      const id = queue?.shift();
      if (queue?.length) this.groupOrder.push(groupId);
      else this.groupQueues.delete(groupId);
      if (!id) continue;
      this.queued--;
      const record = this.records.get(id);
      if (record?.state === 'queued') return record;
    }
    return null;
  }

  _start(record) {
    record.state = 'running';
    record.startedAt = new Date().toISOString();
    record.workerActive = true;
    record.controller = new AbortController();
    this.occupied++;
    this._emit('started', record);
    const startedAt = Date.now();
    record.hardDeadlineAt = startedAt + Math.max(record.timeoutMs, this.maxHeartbeatLifetimeMs);
    this._armTimeout(record, startedAt + record.timeoutMs);
    // Begin in another microtask so a synchronous throw is treated identically
    // to an asynchronous rejection and cannot unwind the queue scheduler.
    Promise.resolve().then(() => {
      if (TERMINAL.has(record.state)) return undefined;
      return this.execute(
        jsonCopy(record.workUnit, 'workUnit'),
        record.controller.signal,
        { id: record.id, groupId: record.groupId, label: record.label, metadata: jsonCopy(record.metadata, 'metadata') },
      );
    }).then(
      (value) => {
        if (TERMINAL.has(record.state)) return;
        if (value?.__orchestratorState === 'failed') {
          try { record.result = jsonCopy(value.result ?? {}, 'result'); }
          catch (error) { this._finish(record, 'failed', errorSummary(error)); return; }
          this._finish(record, 'failed', errorSummary(new Error(String(value.reason || 'Worker reported failure'))));
          return;
        }
        if (value?.__orchestratorState === 'waiting_for_provider') {
          try { record.result = jsonCopy(value.result ?? {}, 'result'); }
          catch (error) { this._finish(record, 'failed', errorSummary(error)); return; }
          record.state = 'waiting_for_provider';
          record.error = errorSummary(new Error(String(value.reason || 'A model provider is not available')));
          record.endedAt = null;
          record.controller = null;
          this._emit('waiting_for_provider', record);
          return;
        }
        try {
          record.result = jsonCopy(value, 'result');
          this._finish(record, 'completed');
        } catch (error) {
          this._finish(record, 'failed', errorSummary(error));
        }
      },
      (error) => {
        if (!TERMINAL.has(record.state)) this._finish(record, 'failed', errorSummary(error));
      },
    ).finally(() => {
      clearTimeout(record.timer);
      record.workerActive = false;
      this.occupied--;
      this._scheduleDrain();
      this._prune();
    });
  }

  _armTimeout(record, deadlineAt) {
    clearTimeout(record.timer);
    record.deadlineAt = deadlineAt;
    const delay = Math.max(0, Math.min(deadlineAt, record.hardDeadlineAt) - Date.now());
    record.timer = setTimeout(() => this._stop(record, 'timed_out'), delay);
    record.timer.unref?.();
  }

  /** Extend a running worker's inactivity lease, bounded by its hard lifetime. */
  heartbeat(id) {
    const record = this._get(id);
    if (record.state !== 'running') throw new Error('Only running work units accept heartbeats');
    const now = Date.now();
    if (now >= record.hardDeadlineAt) {
      this._stop(record, 'timed_out');
      return this._snapshot(record);
    }
    this._armTimeout(record, Math.min(now + record.timeoutMs, record.hardDeadlineAt));
    return { ...this._snapshot(record), leaseExpiresAt: new Date(record.deadlineAt).toISOString(), hardDeadlineAt: new Date(record.hardDeadlineAt).toISOString() };
  }

  _finish(record, state, error = null) {
    if (TERMINAL.has(record.state)) return;
    record.state = state;
    record.error = error;
    record.endedAt = new Date().toISOString();
    clearTimeout(record.timer);
    this._emit(state, record);
    record.resolveDone(this._snapshot(record, true));
  }

  _stop(record, state) {
    if (TERMINAL.has(record.state)) return;
    if (record.state === 'queued') {
      const queue = this.groupQueues.get(record.groupId);
      const index = queue?.indexOf(record.id) ?? -1;
      if (index !== -1) { queue.splice(index, 1); this.queued--; }
      if (!queue?.length) {
        this.groupQueues.delete(record.groupId);
        this.groupOrder = this.groupOrder.filter((id) => id !== record.groupId);
      }
    }
    const error = state === 'timed_out'
      ? { name: 'TimeoutError', message: `Work unit exceeded ${record.timeoutMs} ms` }
      : { name: 'AbortError', message: 'Work unit was cancelled' };
    this._finish(record, state, error);
    if (record.controller && !record.controller.signal.aborted) record.controller.abort(error);
    this._scheduleDrain();
  }

  cancel(id) {
    const record = this._get(id);
    this._stop(record, 'cancelled');
    return this._snapshot(record);
  }

  cancelGroup(groupId) {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.groupId === groupId && !TERMINAL.has(record.state)) {
        this._stop(record, 'cancelled');
        count++;
      }
    }
    return count;
  }

  /** Requeue work parked until its required provider becomes available. */
  resume(id) {
    const record = this._get(id);
    if (record.state !== 'waiting_for_provider') throw new Error('Work unit is not waiting for a provider');
    if (this.closed) throw new Error('Orchestrator is closed');
    record.state = 'queued';
    record.result = undefined;
    record.error = null;
    record.endedAt = null;
    record.createdAt = new Date().toISOString();
    if (!this.groupQueues.has(record.groupId)) {
      this.groupQueues.set(record.groupId, []);
      this.groupOrder.push(record.groupId);
    }
    this.groupQueues.get(record.groupId).push(record.id);
    this.queued++;
    this._emit('queued', record);
    this._scheduleDrain();
    return this._snapshot(record);
  }

  _get(id) {
    const record = this.records.get(id);
    if (!record) throw new Error('Work unit not found in this orchestrator generation');
    return record;
  }

  status(id) { return this._snapshot(this._get(id)); }
  result(id) { return this._snapshot(this._get(id), true); }

  list({ groupId, state, limit = 100 } = {}) {
    integerInRange(limit, 'limit', 1, 1000);
    return [...this.records.values()].reverse()
      .filter((record) => (groupId === undefined || record.groupId === groupId) && (state === undefined || record.state === state))
      .slice(0, limit).map((record) => this._snapshot(record));
  }

  stats() {
    const states = { queued: 0, running: 0, waiting_for_provider: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0 };
    for (const record of this.records.values()) states[record.state]++;
    return { concurrency: this.concurrency, maxQueued: this.maxQueued, occupied: this.occupied, queued: this.queued, records: this.records.size, states, closed: this.closed };
  }

  setConcurrency(concurrency) {
    this.concurrency = integerInRange(concurrency, 'concurrency', 1, MAX_CONCURRENCY);
    this._scheduleDrain();
    return this.stats();
  }

  history({ afterId = 0, limit = 100 } = {}) {
    integerInRange(afterId, 'afterId', 0, Number.MAX_SAFE_INTEGER);
    integerInRange(limit, 'limit', 1, 1000);
    return jsonCopy(this.events.filter((event) => event.eventId > afterId).slice(0, limit), 'events', 8 * 1024 * 1024);
  }

  async wait(id, timeoutMs = 30000) {
    integerInRange(timeoutMs, 'timeoutMs', 0, 3600000);
    const record = this._get(id);
    if (TERMINAL.has(record.state) || record.state === 'waiting_for_provider') return this.result(id);
    if (timeoutMs === 0) return this.result(id);
    let timer;
    let resolveProviderWait;
    const providerWait = new Promise((resolve) => {
      resolveProviderWait = resolve;
      record.providerWaiters.add(resolve);
    });
    try {
      return await Promise.race([
        record.done,
        providerWait,
        new Promise((resolve) => { timer = setTimeout(() => resolve(this.result(id)), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      record.providerWaiters.delete(resolveProviderWait);
    }
  }

  /** Stops accepting new work. Active executors still own slots until settled. */
  close({ cancel = true } = {}) {
    this.closed = true;
    if (cancel) for (const record of this.records.values()) this._stop(record, 'cancelled');
    return this.stats();
  }

  _prune() {
    if (this.records.size <= this.maxRecords) return;
    for (const [id, record] of this.records) {
      if (TERMINAL.has(record.state) && !record.workerActive) this.records.delete(id);
      if (this.records.size <= this.maxRecords) break;
    }
  }
}

export const AGENT_ORCHESTRATOR_MAX_CONCURRENCY = MAX_CONCURRENCY;
