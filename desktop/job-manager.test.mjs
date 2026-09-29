import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobManager, parsePosixProcessIdentityLine } from './job-manager.mjs';

test('POSIX process identity parser keeps PID, executable, and native start time', () => {
  const parsed = parsePosixProcessIdentityLine('Sun Sep 28 14:01:02 2026 /usr/bin/node', 123);
  assert.equal(parsed.verified, true);
  assert.equal(parsed.pid, 123);
  assert.equal(parsed.executable, '/usr/bin/node');
  assert.ok(Number.isFinite(parsed.startedAt));
  assert.equal(parsePosixProcessIdentityLine('broken', 123).verified, false);
});

test('orphan recovery kills only a process with matching PID, executable, and start time', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-job-recovery-'));
  const recoveryFile = path.join(directory, 'jobs.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const startedAt = Date.now();
  await fs.writeFile(recoveryFile, JSON.stringify({ version: 1, jobs: [
    { id: 'owned', pid: 41, executable: '/usr/bin/node', startedAt },
    { id: 'reused-pid', pid: 42, executable: '/usr/bin/node', startedAt },
    { id: 'unknown', pid: 43, executable: '/usr/bin/node', startedAt },
    { id: 'gone', pid: 44, executable: '/usr/bin/node', startedAt },
  ] }));
  const stopped = [];
  const manager = new JobManager({ recoveryFile,
    inspectProcess: async (pid) => pid === 44 ? null : pid === 43 ? ({ verified: false, reason: 'identity inspection unavailable' })
      : ({ verified: true, pid, executable: '/usr/bin/node', startedAt: pid === 42 ? startedAt + 10000 : startedAt }),
    terminateProcessTree: async (pid) => { stopped.push(pid); return true; },
  });
  const summary = await manager.recoverOrphans();
  assert.deepEqual(stopped, [41]);
  assert.deepEqual(summary.recovered, [{ jobId: 'owned', pid: 41 }]);
  assert.equal(summary.stale, 2);
  assert.match(summary.unresolved[0].reason, /identity/i);
  const persisted = JSON.parse(await fs.readFile(recoveryFile, 'utf8'));
  assert.deepEqual(persisted.jobs.map((record) => record.id), ['unknown']);
});

test('active child ledger contains process identity only and clears after the process ends', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-job-ledger-'));
  const recoveryFile = path.join(directory, 'jobs.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = new JobManager({ recoveryFile });
  const started = manager.start({ program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', 'sensitive-argument'], cwd: process.cwd(), kind: 'terminal', timeoutSeconds: 10 });
  const ledger = JSON.parse(await fs.readFile(recoveryFile, 'utf8'));
  assert.equal(ledger.jobs.length, 1);
  assert.equal(ledger.jobs[0].pid, started.pid);
  assert.equal(JSON.stringify(ledger).includes('sensitive-argument'), false);
  manager.cancel(started.jobId);
  assert.equal((await manager.wait(started.jobId, 10000)).status, 'cancelled');
  assert.deepEqual(JSON.parse(await fs.readFile(recoveryFile, 'utf8')).jobs, []);
});

test('Windows startup recovery terminates a verified orphan process tree', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-orphan-process-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const recoveryFile = path.join(directory, 'jobs.json');
  const previousBackend = new JobManager({ recoveryFile });
  const started = previousBackend.start({ program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), kind: 'native_agent', timeoutSeconds: 60 });
  t.after(() => { try { previousBackend.cancel(started.jobId); } catch {} });
  const restartedBackend = new JobManager({ recoveryFile });
  const recovery = await restartedBackend.recoverOrphans();
  assert.deepEqual(recovery.recovered.map((item) => item.pid), [started.pid]);
  assert.equal(recovery.unresolved.length, 0);
  assert.notEqual((await previousBackend.wait(started.jobId, 5000)).status, 'running');
});

test('background jobs retain bounded output and lifecycle events', async () => {
  const manager = new JobManager({ redact: (value) => value.replaceAll('private-value', '*************') });
  const started = manager.start({
    program: process.execPath,
    args: ['-e', "process.stdout.write('hello private-value'); process.stderr.write('warning')"],
    cwd: process.cwd(), kind: 'project_task', task: 'node-test', timeoutSeconds: 10,
  });
  assert.equal(started.status, 'running');
  const finished = await manager.wait(started.jobId, 10000);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.exitCode, 0);
  const output = manager.output(started.jobId);
  assert.equal(output.stdout.text.includes('private-value'), false);
  assert.match(output.stdout.text, /hello/);
  assert.equal(output.stderr.text, 'warning');
  assert.deepEqual(manager.history().map((event) => event.type), ['job.started', 'job.completed']);
});

test('a running job can be cancelled and then waited on', async () => {
  const manager = new JobManager();
  const started = manager.start({
    program: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(), kind: 'terminal', timeoutSeconds: 10,
  });
  assert.equal(manager.cancel(started.jobId).status, 'cancelling');
  const finished = await manager.wait(started.jobId, 10000);
  assert.equal(finished.status, 'cancelled');
  assert.equal(manager.status(started.jobId).status, 'cancelled');
});

test('a failed command reports its exit code without swallowing output', async () => {
  const manager = new JobManager();
  const started = manager.start({
    program: process.execPath,
    args: ['-e', "process.stderr.write('failure'); process.exit(7)"],
    cwd: process.cwd(), kind: 'project_task', task: 'node-test', timeoutSeconds: 10,
  });
  const finished = await manager.wait(started.jobId, 10000);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.exitCode, 7);
  assert.equal(manager.output(started.jobId, { stream: 'stderr' }).stderr.text, 'failure');
});

test('large output is bounded and reports when older text was discarded', async () => {
  const manager = new JobManager();
  const started = manager.start({
    program: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(1100000))"],
    cwd: process.cwd(), kind: 'project_task', task: 'node-test', timeoutSeconds: 10,
  });
  const finished = await manager.wait(started.jobId, 10000);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.stdoutTruncated, true);
  const output = manager.output(started.jobId, { stream: 'stdout', maxChars: 300 });
  assert.equal(output.stdout.truncatedBeforeOffset, true);
  assert.match(output.stdout.text, /^\*{256}/);
});
