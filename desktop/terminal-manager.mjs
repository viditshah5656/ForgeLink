import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { inspectOwnedProcess, matchesOwnedProcessIdentity, terminateOwnedProcessTree } from './job-manager.mjs';
import { availableNativeShells, resolveTerminalShell } from './platform-runtime.mjs';

const require = createRequire(import.meta.url);
const MAX_SESSIONS = 8;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const MAX_ATTACHMENTS = 32;
const ATTACHMENT_TTL_MS = 15 * 60_000;
const IDLE_TTL_MS = 4 * 60 * 60_000;

let nativePty;
function loadPty() {
  if (nativePty) return nativePty;
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'node-pty');
  nativePty = packaged && fs.existsSync(path.join(packaged, 'package.json'))
    ? require(packaged)
    : require('node-pty');
  return nativePty;
}

function shellDefinition(shell, cwd) {
  return resolveTerminalShell(shell, { cwd });
}

export function availableShells() {
  return availableNativeShells({ cwd: process.cwd() });
}

function appendOutput(output, data) {
  output.text += String(data);
  output.totalChars += String(data).length;
  if (output.text.length > MAX_OUTPUT_CHARS) {
    const dropped = output.text.length - MAX_OUTPUT_CHARS;
    output.text = output.text.slice(dropped);
    output.baseOffset += dropped;
  }
}

function promptFromOutput(text) {
  const plain = text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
  const line = plain.split(/\r?\n/).slice(-3).map((part) => part.trim()).filter(Boolean).at(-1) || '';
  if (!line) return null;
  const patterns = [
    ['password', /(?:password|passphrase)\s*:\s*$/i],
    ['username', /(?:username|login)\s*:\s*$/i],
    ['confirmation', /(?:continue|are you sure|accept license|proceed).*?(?:\[y\/n\]|\(y\/n\)|\?)\s*$/i],
    ['selection', /(?:select|choose)\s+(?:an?\s+)?(?:option|item|number).*?:?\s*$/i],
    ['enter', /press\s+enter.*$/i],
  ];
  const match = patterns.find(([, pattern]) => pattern.test(line));
  return match ? { kind: match[0], text: line.slice(-300) } : null;
}

function terminateTree(pty, force = false) {
  if (process.platform !== 'win32' || !Number.isInteger(pty.pid)) {
    pty.kill(force ? 'SIGKILL' : 'SIGHUP');
    return;
  }
  const killer = spawn('taskkill.exe', ['/PID', String(pty.pid), '/T', '/F'], {
    windowsHide: true, shell: false, stdio: 'ignore',
  });
  killer.once('error', () => { try { pty.kill(); } catch {} });
  killer.once('close', (code) => { if (code !== 0) { try { pty.kill(); } catch {} } });
}

export class TerminalManager {
  constructor({ createPty = (...args) => loadPty().spawn(...args), environment = () => process.env, redact = (value) => value, onEvent = () => {},
    recoveryFile = null, inspectProcess = inspectOwnedProcess, terminateProcessTree = terminateOwnedProcessTree } = {}) {
    this.createPty = createPty;
    this.environment = environment;
    this.redact = redact;
    this.onEvent = onEvent;
    this.recoveryFile = recoveryFile ? path.resolve(recoveryFile) : null;
    this.inspectProcess = inspectProcess;
    this.terminateProcessTree = terminateProcessTree;
    this.lastRecovery = { recovered: [], unresolved: [], stale: 0 };
    this.sessions = new Map();
  }

  persistActiveProcesses() {
    if (!this.recoveryFile) return;
    const terminals = [...this.sessions.values()].filter((session) => ['running', 'closing'].includes(session.status) && session.identity?.pid)
      .map((session) => ({ id: session.id, pid: session.identity.pid, executable: session.identity.executable, startedAt: session.identity.startedAt }));
    fs.mkdirSync(path.dirname(this.recoveryFile), { recursive: true });
    const temporary = `${this.recoveryFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, terminals }), { mode: 0o600 });
    try { fs.renameSync(temporary, this.recoveryFile); }
    catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  }

  async recoverOrphans() {
    if (!this.recoveryFile) return structuredClone(this.lastRecovery);
    let document;
    try { document = JSON.parse(fs.readFileSync(this.recoveryFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return structuredClone(this.lastRecovery);
      return { recovered: [], unresolved: [{ reason: 'The terminal recovery ledger could not be read safely.' }], stale: 0 };
    }
    if (document?.version !== 1 || !Array.isArray(document.terminals) || document.terminals.length > MAX_SESSIONS) {
      return { recovered: [], unresolved: [{ reason: 'The terminal recovery ledger has an unsupported or oversized format.' }], stale: 0 };
    }
    const recovered = [];
    const unresolved = [];
    const retained = [];
    let stale = 0;
    for (const record of document.terminals) {
      if (!record || typeof record.id !== 'string' || !Number.isInteger(record.pid) || record.pid <= 0 ||
          typeof record.executable !== 'string' || !Number.isFinite(record.startedAt)) {
        unresolved.push({ reason: 'A terminal recovery record has invalid process identity fields.' });
        retained.push(record);
        continue;
      }
      const identity = await this.inspectProcess(record.pid).catch(() => ({ verified: false, reason: 'Process identity inspection failed.' }));
      if (identity === null) { stale++; continue; }
      if (!matchesOwnedProcessIdentity(record, identity)) {
        if (identity?.verified) stale++;
        else {
          unresolved.push({ sessionId: record.id, pid: record.pid, reason: identity?.reason || 'Process identity could not be verified; no process was stopped.' });
          retained.push(record);
        }
        continue;
      }
      const confirmed = await this.inspectProcess(record.pid).catch(() => ({ verified: false, reason: 'Process identity recheck failed.' }));
      if (confirmed === null) { stale++; continue; }
      if (!matchesOwnedProcessIdentity(record, confirmed)) {
        if (confirmed?.verified) stale++;
        else {
          unresolved.push({ sessionId: record.id, pid: record.pid, reason: confirmed?.reason || 'Process identity could not be rechecked; no process was stopped.' });
          retained.push(record);
        }
        continue;
      }
      const stopped = await this.terminateProcessTree(record.pid).catch(() => false);
      if (stopped) recovered.push({ sessionId: record.id, pid: record.pid });
      else {
        unresolved.push({ sessionId: record.id, pid: record.pid, reason: 'Owned terminal process was identified but could not be stopped.' });
        retained.push(record);
      }
    }
    this.lastRecovery = { recovered, unresolved, stale };
    const temporary = `${this.recoveryFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, terminals: retained.slice(-MAX_SESSIONS) }), { mode: 0o600 });
    try { fs.renameSync(temporary, this.recoveryFile); }
    catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    return structuredClone(this.lastRecovery);
  }

  emit(type, session) {
    try { this.onEvent({ type, sessionId: session.id, at: new Date().toISOString(), status: session.status }); } catch {}
  }

  summary(session) {
    return {
      sessionId: session.id,
      shell: session.shell,
      cwd: session.cwd,
      owner: session.owner || null,
      pid: session.pty.pid,
      parentPid: process.pid,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      endedAt: session.endedAt,
      status: session.status,
      exitCode: session.exitCode,
      cols: session.cols,
      rows: session.rows,
      pty: true,
      environmentKeys: session.environmentKeys,
      attachmentCount: session.attachments.size,
      outputChars: session.output.totalChars,
      outputTruncated: session.output.baseOffset > 0,
    };
  }

  create({ shell, cwd, cols = 80, rows = 24, env: environmentOverride, owner = null }) {
    const active = [...this.sessions.values()].filter((session) => session.status === 'running').length;
    if (active >= MAX_SESSIONS) throw new Error(`At most ${MAX_SESSIONS} terminal sessions may run at once`);
    const { file, args } = shellDefinition(shell, cwd);
    const env = environmentOverride || this.environment();
    const pty = this.createPty(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
    const now = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(), shell, cwd, owner, pty, cols, rows, createdAt: now, lastActivity: now,
      identity: { pid: pty.pid, executable: file, startedAt: Date.parse(now) },
      endedAt: null, status: 'running', exitCode: null,
      environmentKeys: Object.keys(env).sort(),
      output: { text: '', baseOffset: 0, totalChars: 0 },
      attachments: new Map(),
    };
    this.sessions.set(session.id, session);
    pty.onData((data) => {
      appendOutput(session.output, data);
      session.lastActivity = new Date().toISOString();
    });
    pty.onExit(({ exitCode }) => {
      session.status = session.status === 'closing' ? 'closed' : 'exited';
      session.exitCode = exitCode;
      session.endedAt = new Date().toISOString();
      session.lastActivity = session.endedAt;
      try { this.persistActiveProcesses(); } catch {}
      this.emit('terminal.exited', session);
    });
    try { this.persistActiveProcesses(); }
    catch (error) { this.sessions.delete(session.id); terminateTree(pty, true); throw error; }
    this.emit('terminal.created', session);
    this.prune();
    return this.summary(session);
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Terminal session not found in this backend generation');
    return session;
  }

  list(limit = 25) {
    return [...this.sessions.values()].slice(-limit).reverse().map((session) => this.summary(session));
  }

  status(id) {
    return this.summary(this.get(id));
  }

  attach(id, afterOffset) {
    const session = this.get(id);
    if (session.attachments.size >= MAX_ATTACHMENTS) throw new Error('Too many attachments to this terminal');
    const attachmentId = crypto.randomUUID();
    session.attachments.set(attachmentId, { afterOffset: afterOffset ?? session.output.baseOffset, lastActivity: Date.now() });
    return { ...this.summary(session), attachmentId };
  }

  detach(id, attachmentId) {
    const session = this.get(id);
    return { sessionId: id, detached: session.attachments.delete(attachmentId) };
  }

  reconnect(id, attachmentId, afterOffset) {
    const session = this.get(id);
    const previous = attachmentId ? session.attachments.get(attachmentId) : null;
    const cursor = afterOffset ?? previous?.afterOffset ?? session.output.baseOffset;
    if (attachmentId) session.attachments.delete(attachmentId);
    return this.attach(id, cursor);
  }

  read(id, { attachmentId, afterOffset = 0, maxChars = 20000 } = {}) {
    const session = this.get(id);
    const attachment = attachmentId ? session.attachments.get(attachmentId) : null;
    if (attachmentId && !attachment) throw new Error('Terminal attachment not found or expired');
    const output = session.output;
    const requested = attachment ? attachment.afterOffset : afterOffset;
    const start = Math.max(output.baseOffset, requested);
    const redacted = this.redact(output.text);
    const safe = output.baseOffset > 0
      ? '*'.repeat(Math.min(256, redacted.length)) + redacted.slice(256)
      : redacted;
    const text = safe.slice(start - output.baseOffset, start - output.baseOffset + maxChars);
    const nextOffset = start + text.length;
    if (attachment) { attachment.afterOffset = nextOffset; attachment.lastActivity = Date.now(); }
    return {
      sessionId: id, status: session.status, text, offset: start, nextOffset,
      truncatedBeforeOffset: requested < output.baseOffset,
      prompt: promptFromOutput(this.redact(output.text.slice(-2000))),
    };
  }

  snapshot(id, maxChars = 4000) {
    const session = this.get(id);
    const afterOffset = Math.max(session.output.baseOffset, session.output.totalChars - maxChars);
    return { ...this.summary(session), output: this.read(id, { afterOffset, maxChars }) };
  }

  input(id, text, enter = false) {
    const session = this.get(id);
    if (session.status !== 'running') throw new Error('Terminal session is not running');
    session.pty.write(text + (enter ? '\r' : ''));
    session.lastActivity = new Date().toISOString();
    this.emit('terminal.input', session);
    return { sessionId: id, acceptedChars: text.length + Number(enter), status: session.status };
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (session.status !== 'running') throw new Error('Terminal session is not running');
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    session.lastActivity = new Date().toISOString();
    return this.summary(session);
  }

  signal(id, signal) {
    const session = this.get(id);
    if (session.status !== 'running') return this.summary(session);
    if (signal === 'interrupt') session.pty.write('\x03');
    else {
      session.status = 'closing';
      try { this.persistActiveProcesses(); } catch {}
      terminateTree(session.pty, signal === 'kill');
    }
    session.lastActivity = new Date().toISOString();
    this.emit('terminal.signal', session);
    return this.summary(session);
  }

  close(id) {
    return this.signal(id, 'terminate');
  }

  closeAll() {
    for (const session of this.sessions.values()) if (session.status === 'running') this.close(session.id);
  }

  closeWhere(predicate) {
    for (const session of this.sessions.values()) if (session.status === 'running' && predicate(this.summary(session))) this.close(session.id);
  }

  sweep() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      for (const [id, attachment] of session.attachments) {
        if (now - attachment.lastActivity > ATTACHMENT_TTL_MS) session.attachments.delete(id);
      }
      if (session.status === 'running' && now - Date.parse(session.lastActivity) > IDLE_TTL_MS) this.close(session.id);
    }
    this.prune();
  }

  prune() {
    if (this.sessions.size <= MAX_SESSIONS * 4) return;
    for (const [id, session] of this.sessions) {
      if (session.status === 'closed' || session.status === 'exited') this.sessions.delete(id);
      if (this.sessions.size <= MAX_SESSIONS * 3) break;
    }
  }
}
