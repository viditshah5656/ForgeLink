import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalManager, availableShells } from './terminal-manager.mjs';

test('terminal process ledger is minimal and restart recovery verifies process identity twice', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-terminal-recovery-'));
  const recoveryFile = path.join(directory, 'terminals.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const startedAt = Date.now();
  await fs.writeFile(recoveryFile, JSON.stringify({ version: 1, terminals: [
    { id: 'owned-terminal', pid: 91, executable: 'C:\\Windows\\System32\\cmd.exe', startedAt },
    { id: 'reused-terminal-pid', pid: 92, executable: 'C:\\Windows\\System32\\cmd.exe', startedAt },
    { id: 'unverified-terminal', pid: 93, executable: 'C:\\Windows\\System32\\cmd.exe', startedAt },
  ] }));
  const inspected = [];
  const stopped = [];
  const manager = new TerminalManager({ recoveryFile,
    inspectProcess: async (pid) => {
      inspected.push(pid);
      if (pid === 93) return { verified: false, reason: 'inspection unavailable' };
      return { verified: true, pid, executable: 'C:\\Windows\\System32\\cmd.exe', startedAt: pid === 92 ? startedAt + 10000 : startedAt };
    },
    terminateProcessTree: async (pid) => { stopped.push(pid); return true; },
  });
  const result = await manager.recoverOrphans();
  assert.deepEqual(stopped, [91]);
  assert.equal(inspected.filter((pid) => pid === 91).length, 2);
  assert.deepEqual(result.recovered, [{ sessionId: 'owned-terminal', pid: 91 }]);
  assert.equal(result.stale, 1);
  assert.match(result.unresolved[0].reason, /inspection unavailable/);
  assert.deepEqual(JSON.parse(await fs.readFile(recoveryFile, 'utf8')).terminals.map((record) => record.id), ['unverified-terminal']);
});

test('terminal session ledger is removed after its PTY exits', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-terminal-ledger-'));
  const recoveryFile = path.join(directory, 'terminals.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let terminal;
  const manager = new TerminalManager({ recoveryFile, createPty: () => {
    terminal = { pid: 123, onData(callback) { this.data = callback; }, onExit(callback) { this.exit = callback; }, kill() { this.exit({ exitCode: 0 }); } };
    return terminal;
  } });
  const created = manager.create({ shell: process.platform === 'win32' ? 'cmd' : 'sh', cwd: process.cwd(), env: { PATH: '' } });
  const ledger = JSON.parse(await fs.readFile(recoveryFile, 'utf8'));
  assert.equal(ledger.terminals.length, 1);
  assert.equal(ledger.terminals[0].pid, 123);
  assert.equal('cwd' in ledger.terminals[0], false);
  manager.close(created.sessionId);
  terminal.exit({ exitCode: 0 });
  assert.deepEqual(JSON.parse(await fs.readFile(recoveryFile, 'utf8')).terminals, []);
});

test('terminal sessions keep interactive state, cursors, resize, and prompt hints', () => {
  let terminal;
  const manager = new TerminalManager({
    environment: () => ({ PATH: process.env.PATH || '' }),
    redact: (value) => value.replaceAll('private-value', '*************'),
    createPty: () => {
      terminal = {
        pid: null, writes: [],
        onData(callback) { this.data = callback; },
        onExit(callback) { this.exit = callback; },
        write(value) { this.writes.push(value); },
        resize(cols, rows) { this.size = { cols, rows }; },
        kill() { this.exit({ exitCode: 0 }); },
      };
      return terminal;
    },
  });
  const shell = process.platform === 'win32' ? 'cmd' : 'sh';
  assert.ok(availableShells().includes(shell));
  const created = manager.create({ shell, cwd: process.cwd(), cols: 80, rows: 24 });
  assert.equal(created.status, 'running');
  assert.equal(created.pty, true);
  assert.deepEqual(created.environmentKeys, ['PATH']);
  const attachment = manager.attach(created.sessionId);
  terminal.data('Password: ');
  const first = manager.read(created.sessionId, { attachmentId: attachment.attachmentId });
  assert.equal(first.prompt.kind, 'password');
  assert.equal(first.text, 'Password: ');
  terminal.data('private-value');
  const resumed = manager.reconnect(created.sessionId, attachment.attachmentId);
  assert.notEqual(resumed.attachmentId, attachment.attachmentId);
  const second = manager.read(created.sessionId, { attachmentId: resumed.attachmentId });
  assert.equal(second.text.includes('private-value'), false);
  assert.equal(second.text, '*************');
  assert.deepEqual(manager.input(created.sessionId, 'echo ready', true), { sessionId: created.sessionId, acceptedChars: 11, status: 'running' });
  manager.signal(created.sessionId, 'interrupt');
  assert.deepEqual(terminal.writes, ['echo ready\r', '\x03']);
  assert.equal(manager.resize(created.sessionId, 100, 30).cols, 100);
  assert.deepEqual(terminal.size, { cols: 100, rows: 30 });
  assert.equal(manager.detach(created.sessionId, resumed.attachmentId).detached, true);
  manager.close(created.sessionId);
  assert.equal(manager.status(created.sessionId).status, 'closed');
});

test('terminal output stays bounded and masks a truncated boundary', () => {
  let terminal;
  const manager = new TerminalManager({
    createPty: () => {
      terminal = { pid: null, onData(callback) { this.data = callback; }, onExit(callback) { this.exit = callback; }, kill() { this.exit({ exitCode: 0 }); } };
      return terminal;
    },
  });
  const shell = process.platform === 'win32' ? 'cmd' : 'sh';
  const created = manager.create({ shell, cwd: process.cwd() });
  terminal.data('x'.repeat(1100000));
  const output = manager.read(created.sessionId, { maxChars: 300 });
  assert.equal(output.truncatedBeforeOffset, true);
  assert.match(output.text, /^\*{256}/);
  assert.equal(manager.status(created.sessionId).outputTruncated, true);
  manager.close(created.sessionId);
});
