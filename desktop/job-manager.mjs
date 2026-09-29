import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const OUTPUT_LIMIT = 1024 * 1024;
const MAX_JOBS = 32;
const MAX_EVENTS = 500;
const MAX_RECOVERY_RECORDS = 32;
const execFileAsync = promisify(execFile);

function appendBounded(record, chunk) {
  const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  record.text += value;
  if (record.text.length > OUTPUT_LIMIT) {
    const removed = record.text.length - OUTPUT_LIMIT;
    record.text = record.text.slice(removed);
    record.baseOffset += removed;
  }
  record.totalChars += value.length;
}

function terminateChild(child) {
  if (process.platform !== 'win32' || !Number.isInteger(child.pid)) {
    child.kill();
    return;
  }
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true, shell: false, stdio: 'ignore',
  });
  killer.once('error', () => child.kill());
  killer.once('close', (code) => { if (code !== 0) child.kill(); });
}

async function inspectWindowsProcess(pid) {
  if (process.platform !== 'win32') return { verified: false, reason: 'Windows process inspection is unavailable on this platform.' };
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue; if ($null -ne $p) { [pscustomobject]@{pid=$p.ProcessId; executable=$p.ExecutablePath; startedAt=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 });
    if (!stdout.trim()) return null;
    const value = JSON.parse(stdout.trim());
    const startedAt = Date.parse(value.startedAt);
    if (value.pid !== pid || typeof value.executable !== 'string' || !Number.isFinite(startedAt)) return { verified: false, reason: 'Operating system returned incomplete process identity.' };
    return { verified: true, pid, executable: value.executable, startedAt };
  } catch {
    return { verified: false, reason: 'Operating system process identity could not be inspected.' };
  }
}

export function parsePosixProcessIdentityLine(line, pid) {
  const match = String(line || '').trim().match(/^(.{24})\s+(.+)$/);
  if (!match) return { verified: false, reason: 'POSIX process identity output was incomplete.' };
  const startedAt = Date.parse(match[1]);
  const executable = match[2].trim();
  if (!Number.isFinite(startedAt) || !executable) return { verified: false, reason: 'POSIX process identity could not be parsed.' };
  return { verified: true, pid, executable, startedAt };
}

async function inspectPosixProcess(pid) {
  if (!['darwin', 'linux'].includes(process.platform)) return { verified: false, reason: 'POSIX process inspection is unavailable on this platform.' };
  const ps = fs.existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
  try {
    const { stdout } = await execFileAsync(ps, ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 16 * 1024,
    });
    if (!stdout.trim()) return null;
    return parsePosixProcessIdentityLine(stdout.trim().split(/\r?\n/).at(-1), pid);
  } catch (error) {
    if (error?.code === 1 || error?.code === 'ESRCH') return null;
    return { verified: false, reason: 'Operating system process identity could not be inspected.' };
  }
}

async function inspectOwnedProcess(pid) {
  return process.platform === 'win32' ? inspectWindowsProcess(pid) : inspectPosixProcess(pid);
}

async function terminateWindowsProcessTree(pid) {
  if (process.platform !== 'win32') return false;
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 });
    return true;
  } catch (error) {
    return error.code === 128 || /not found|no running instance/i.test(`${error.stdout || ''} ${error.stderr || ''}`);
  }
}

async function terminatePosixOwnedProcess(pid) {
  if (!['darwin', 'linux'].includes(process.platform)) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    return error?.code === 'ESRCH';
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

async function terminateOwnedProcessTree(pid) {
  return process.platform === 'win32' ? terminateWindowsProcessTree(pid) : terminatePosixOwnedProcess(pid);
}

function sameExecutable(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const normalize = (value) => {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const left = normalize(expected);
  const right = normalize(actual);
  return path.isAbsolute(expected) ? left === right : path.basename(left) === path.basename(right);
}

function matchesProcessIdentity(record, identity) {
  return identity?.verified === true && identity.pid === record.pid && sameExecutable(record.executable, identity.executable) &&
    Math.abs(identity.startedAt - record.startedAt) <= 5000;
}

export { inspectOwnedProcess, terminateOwnedProcessTree, matchesProcessIdentity as matchesOwnedProcessIdentity };

export class JobManager {
  constructor({ environment = () => process.env, onEvent = () => {}, redact = (value) => value, maxJobs = MAX_JOBS,
    recoveryFile = null, inspectProcess = inspectOwnedProcess, terminateProcessTree = terminateOwnedProcessTree } = {}) {
    this.environment = environment;
    this.onEvent = onEvent;
    this.redact = redact;
    this.maxJobs = maxJobs;
    this.recoveryFile = recoveryFile ? path.resolve(recoveryFile) : null;
    this.inspectProcess = inspectProcess;
    this.terminateProcessTree = terminateProcessTree;
    this.lastRecovery = { recovered: [], unresolved: [], stale: 0 };
    this.jobs = new Map();
    this.events = [];
    this.nextEventId = 1;
  }

  emit(type, job) {
    const event = { id: this.nextEventId++, at: new Date().toISOString(), type, jobId: job.id, status: job.status };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    try { this.onEvent(event); } catch {}
  }

  _persistActiveProcesses() {
    if (!this.recoveryFile) return;
    const jobs = [...this.jobs.values()].filter((job) => ['running', 'cancelling', 'timing_out'].includes(job.status) && job.identity?.pid)
      .slice(-MAX_RECOVERY_RECORDS).map((job) => ({ id: job.id, pid: job.identity.pid, executable: job.identity.executable, startedAt: job.identity.startedAt }));
    const directory = path.dirname(this.recoveryFile);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.recoveryFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, jobs }), { mode: 0o600 });
    try { fs.renameSync(temporary, this.recoveryFile); }
    catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  }

  async recoverOrphans() {
    if (!this.recoveryFile) return structuredClone(this.lastRecovery);
    let document;
    try { document = JSON.parse(fs.readFileSync(this.recoveryFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return structuredClone(this.lastRecovery);
      return { recovered: [], unresolved: [{ reason: 'The process recovery ledger could not be read safely.' }], stale: 0 };
    }
    if (document?.version !== 1 || !Array.isArray(document.jobs) || document.jobs.length > MAX_RECOVERY_RECORDS) {
      return { recovered: [], unresolved: [{ reason: 'The process recovery ledger has an unsupported or oversized format.' }], stale: 0 };
    }
    const recovered = [];
    const unresolved = [];
    let stale = 0;
    const retained = [];
    for (const record of document.jobs) {
      if (!record || typeof record.id !== 'string' || !Number.isInteger(record.pid) || record.pid <= 0 ||
          typeof record.executable !== 'string' || !Number.isFinite(record.startedAt)) {
        unresolved.push({ reason: 'A recovery record has invalid process identity fields.' });
        retained.push(record);
        continue;
      }
      const identity = await this.inspectProcess(record.pid).catch(() => ({ verified: false, reason: 'Process identity inspection failed.' }));
      if (identity === null) { stale++; continue; }
      if (!identity?.verified) {
        unresolved.push({ jobId: record.id, pid: record.pid, reason: identity?.reason || 'Process identity could not be verified; no process was stopped.' });
        retained.push(record);
        continue;
      }
      if (!matchesProcessIdentity(record, identity)) {
        stale++;
        continue;
      }
      const confirmed = await this.inspectProcess(record.pid).catch(() => ({ verified: false, reason: 'Process identity recheck failed.' }));
      if (confirmed === null) { stale++; continue; }
      if (!confirmed?.verified) {
        unresolved.push({ jobId: record.id, pid: record.pid, reason: confirmed?.reason || 'Process identity could not be rechecked; no process was stopped.' });
        retained.push(record);
        continue;
      }
      if (!matchesProcessIdentity(record, confirmed)) { stale++; continue; }
      const stopped = await this.terminateProcessTree(record.pid).catch(() => false);
      if (stopped) recovered.push({ jobId: record.id, pid: record.pid });
      else {
        unresolved.push({ jobId: record.id, pid: record.pid, reason: 'Owned process was identified but could not be stopped.' });
        retained.push(record);
      }
    }
    this.lastRecovery = { recovered, unresolved, stale };
    const temporary = `${this.recoveryFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, jobs: retained.slice(-MAX_RECOVERY_RECORDS) }), { mode: 0o600 });
    try { fs.renameSync(temporary, this.recoveryFile); }
    catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    return structuredClone(this.lastRecovery);
  }

  summary(job) {
    return {
      jobId: job.id,
      kind: job.kind,
      task: job.task,
      cwd: job.cwd,
      pid: job.child?.pid ?? null,
      createdAt: job.createdAt,
      endedAt: job.endedAt,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      stdoutChars: job.stdout.totalChars,
      stderrChars: job.stderr.totalChars,
      stdoutTruncated: job.stdout.baseOffset > 0,
      stderrTruncated: job.stderr.baseOffset > 0,
      error: job.error,
    };
  }

  start({ program, args = [], cwd, kind, task = null, timeoutSeconds = 3600 }) {
    const running = [...this.jobs.values()].filter((job) => job.status === 'running').length;
    if (running >= this.maxJobs) throw new Error(`At most ${this.maxJobs} jobs may run at once`);
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    const executable = path.isAbsolute(program) || program.includes('/') || program.includes('\\') ? path.resolve(cwd, program) : program;
    const job = {
      id, child: null, kind, task, cwd, createdAt: new Date(startedAt).toISOString(), endedAt: null,
      status: 'starting', exitCode: null, signal: null, error: null,
      stdout: { text: '', baseOffset: 0, totalChars: 0 },
      stderr: { text: '', baseOffset: 0, totalChars: 0 },
      timer: null, completion: null, identity: { pid: null, executable, startedAt },
    };
    this.jobs.set(id, job);
    try { this._persistActiveProcesses(); }
    catch (error) { this.jobs.delete(id); throw error; }
    let child;
    try { child = spawn(program, args, { cwd, env: this.environment({ cwd, kind, task }), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) {
      this.jobs.delete(id);
      try { this._persistActiveProcesses(); } catch {}
      throw error;
    }
    job.child = child;
    job.identity.pid = child.pid;
    job.status = 'running';
    try {
      if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error('Operating system did not return a child process ID');
      this._persistActiveProcesses();
    }
    catch (error) { terminateChild(child); this.jobs.delete(id); throw error; }
    child.stdout.on('data', (chunk) => appendBounded(job.stdout, chunk));
    child.stderr.on('data', (chunk) => appendBounded(job.stderr, chunk));
    job.completion = new Promise((resolve) => {
      let settled = false;
      const finish = (status, code = null, signal = null, error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(job.timer);
        job.status = status;
        job.exitCode = code;
        job.signal = signal;
        job.error = error;
        job.endedAt = new Date().toISOString();
        try { this._persistActiveProcesses(); } catch {}
        this.emit(status === 'completed' ? 'job.completed' : status === 'failed' ? 'job.failed' : 'job.cancelled', job);
        resolve(this.summary(job));
      };
      child.once('error', (error) => finish('failed', null, null, error.message));
      child.once('close', (code, signal) => {
        if (job.status === 'cancelling') finish('cancelled', code, signal);
        else if (job.status === 'timing_out') finish('failed', code, signal, 'Job exceeded its time limit');
        else finish(code === 0 ? 'completed' : 'failed', code, signal);
      });
    });
    job.timer = setTimeout(() => {
      if (job.status !== 'running') return;
      job.status = 'timing_out';
      terminateChild(child);
    }, Math.max(1, timeoutSeconds) * 1000);
    job.timer.unref?.();
    this.emit('job.started', job);
    this.prune();
    return this.summary(job);
  }

  prune() {
    if (this.jobs.size <= this.maxJobs * 4) return;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running' && job.status !== 'cancelling' && job.status !== 'timing_out') this.jobs.delete(id);
      if (this.jobs.size <= this.maxJobs * 3) break;
    }
    try { this._persistActiveProcesses(); } catch {}
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Job not found in this backend generation');
    return job;
  }

  list(limit = 25) {
    return [...this.jobs.values()].slice(-limit).reverse().map((job) => this.summary(job));
  }

  status(id) {
    return this.summary(this.get(id));
  }

  output(id, { stream = 'both', stdoutOffset = 0, stderrOffset = 0, maxChars = 20000 } = {}) {
    const job = this.get(id);
    const read = (record, offset) => {
      const start = Math.max(record.baseOffset, offset);
      const redacted = this.redact(record.text);
      // A bounded buffer may begin in the middle of a credential. Mask that
      // boundary, where a pattern-based redactor cannot see the missing prefix.
      const safe = record.baseOffset > 0
        ? '*'.repeat(Math.min(256, redacted.length)) + redacted.slice(256)
        : redacted;
      const text = safe.slice(start - record.baseOffset, start - record.baseOffset + maxChars);
      return { text, offset: start, nextOffset: start + text.length, truncatedBeforeOffset: offset < record.baseOffset };
    };
    return {
      jobId: id,
      status: job.status,
      ...(stream === 'stderr' ? {} : { stdout: read(job.stdout, stdoutOffset) }),
      ...(stream === 'stdout' ? {} : { stderr: read(job.stderr, stderrOffset) }),
    };
  }

  cancel(id) {
    const job = this.get(id);
    if (job.status !== 'running') return this.summary(job);
    job.status = 'cancelling';
    this.emit('job.cancelling', job);
    terminateChild(job.child);
    return this.summary(job);
  }

  cancelAll() {
    for (const job of this.jobs.values()) if (job.status === 'running') this.cancel(job.id);
  }

  cancelKind(kind) {
    for (const job of this.jobs.values()) if (job.kind === kind && job.status === 'running') this.cancel(job.id);
  }

  cancelWhere(predicate) {
    for (const job of this.jobs.values()) if (job.status === 'running' && predicate(this.summary(job))) this.cancel(job.id);
  }

  async wait(id, timeoutMs = 30000) {
    const job = this.get(id);
    if (job.status !== 'running' && job.status !== 'cancelling' && job.status !== 'timing_out') return this.summary(job);
    let timer;
    try {
      return await Promise.race([
        job.completion,
        new Promise((resolve) => { timer = setTimeout(() => resolve(this.summary(job)), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  history(afterId = 0, limit = 100) {
    return this.events.filter((event) => event.id > afterId).slice(-limit);
  }
}
