import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { JobManager } from './job-manager.mjs';
import { createSubagentProcessTools } from './subagent-process-tools.mjs';

test('task-owned process tools run argv-only commands and prevent cross-agent job access', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-agent-process-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const jobs = new JobManager({ environment: () => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }) });
  const layer = createSubagentProcessTools({ jobManager: jobs, root, owner: 'agent-a' });
  const started = await layer.execute('process_start', { command: 'node', args: ['--version'], timeoutSeconds: 5 });
  assert.equal(started.kind, 'native_agent');
  assert.deepEqual(started.task, { swarmId: null, taskId: null, agentId: 'agent-a' });
  const finished = await layer.execute('process_wait', { jobId: started.jobId });
  assert.equal(finished.status, 'completed');
  assert.match(jobs.output(started.jobId).stdout.text, /^v\d/);
  await assert.rejects(layer.execute('process_status', { jobId: 'not-owned' }), /not owned/);
  await assert.rejects(layer.execute('process_start', { command: 'node', args: ['-e', 'process.exit(0)'] }), /Inline Node code/);
  await assert.rejects(layer.execute('process_start', { command: 'git', args: ['push'] }), /read-only Git/);
  await assert.rejects(layer.execute('process_start', { command: 'powershell', args: ['-Command', 'whoami'] }), /must be node/);
  layer.dispose();
  await assert.rejects(layer.execute('process_status', { jobId: started.jobId }), /closed/);
});

test('agent abort and cleanup stop every still-running owned child job', async () => {
  const records = new Map();
  const jobs = {
    start(input) { records.set('owned-job', { ...input, status: 'running' }); return { jobId: 'owned-job', status: 'running' }; },
    status(id) { const record = records.get(id); if (!record) throw new Error('missing'); return record; },
    cancel(id) { records.get(id).status = 'cancelling'; return records.get(id); },
    output() { return {}; }, async wait() { return {}; },
  };
  const controller = new AbortController();
  const layer = createSubagentProcessTools({ jobManager: jobs, root: process.cwd(), owner: 'agent-b', signal: controller.signal });
  await layer.execute('process_start', { command: 'node', args: ['--version'] });
  controller.abort();
  assert.equal(records.get('owned-job').status, 'cancelling');
  await assert.rejects(layer.execute('process_start', { command: 'node', args: ['--version'] }), /closed/);
});

test('task processAccess cannot bypass the owner-controlled Full terminal mode gate', async () => {
  const jobs = { start() { throw new Error('must not start'); }, status() {}, cancel() {}, async wait() {} };
  const layer = createSubagentProcessTools({ jobManager: jobs, root: process.cwd(), owner: 'agent-c', isEnabled: () => false });
  await assert.rejects(layer.execute('process_start', { command: 'node', args: ['--version'] }), /Full terminal mode/);
  await layer.dispose();
});

test('interactive terminal sessions stay owned by one task and are pinned to its private workspace', async () => {
  const sessions = new Map();
  const calls = [];
  const terminals = {
    create(input) { calls.push(input); sessions.set('terminal-a', { sessionId: 'terminal-a', cwd: input.cwd, owner: input.owner, status: 'running' }); return sessions.get('terminal-a'); },
    status(id) { const session = sessions.get(id); if (!session) throw new Error('missing'); return session; },
    input(id, text, enter) { calls.push({ id, text, enter }); return { sessionId: id, acceptedChars: text.length, status: 'running' }; },
    read(id, options) { return { sessionId: id, ...options }; },
    snapshot(id, maxChars) { return { sessionId: id, maxChars }; },
    signal(id, signal) { calls.push({ id, signal }); if (signal !== 'interrupt') sessions.get(id).status = 'closed'; return sessions.get(id); },
    close(id) { sessions.get(id).status = 'closed'; return sessions.get(id); },
  };
  const jobs = { start() { throw new Error('unused'); }, status() { throw new Error('unused'); }, cancel() {}, async wait() { return { status: 'completed' }; } };
  const root = path.join(os.tmpdir(), 'private-agent-workspace');
  const layer = createSubagentProcessTools({ jobManager: jobs, terminalManager: terminals, terminalShells: ['powershell'], root, owner: 'agent-a' });
  const created = await layer.execute('terminal_create', { shell: 'powershell' });
  assert.equal(created.cwd, root);
  assert.deepEqual(calls[0], { shell: 'powershell', cwd: root, env: undefined, owner: { swarmId: null, taskId: null, agentId: 'agent-a' } });
  assert.equal(created.owner.agentId, 'agent-a');
  await assert.rejects(layer.execute('terminal_status', { sessionId: 'other-agent-session' }), /not owned/);
  await layer.execute('terminal_input', { sessionId: created.sessionId, text: 'npm test', enter: true });
  await assert.rejects(layer.execute('terminal_input', { sessionId: created.sessionId, text: 'x'.repeat(20_001), enter: true }), /20,000/);
  await layer.dispose();
  assert.equal(sessions.get(created.sessionId).status, 'closed');
});
