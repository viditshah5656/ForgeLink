import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EngineeringRuntime } from './engineering-protocol.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(url, child, diagnostics) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited early with code ${child.exitCode}: ${diagnostics()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend did not become ready: ${diagnostics()}`);
}

test('MCP background jobs obey guarded mode and expose lifecycle results', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-job-test-'));
  // Model the explicit owner approval required before write-capable process tools.
  const engineering = new EngineeringRuntime({ dataDir: path.join(dataDir, 'engineering') });
  const approved = await engineering.start({ title: 'Process tool integration fixture', root, primaryArtifactId: 'test-plan-artifact' });
  await engineering.plan(approved.id, [{ key: 'exercise', title: 'Exercise process lifecycle' }]);
  await engineering.goal(approved.id, { objective: 'Verify approved process execution and cancellation', acceptanceCriteria: ['process lifecycle works'] });
  await engineering.requestReview(approved.id);
  await engineering.approveReview(approved.id, { approvedBy: 'test-owner' });
  const fixture = await engineering.start({ title: 'Recovery transaction fixture', root: dataDir, primaryArtifactId: 'test-recovery-plan' });
  await engineering.plan(fixture.id, [{ key: 'recover', title: 'Exercise transaction recovery' }]);
  await engineering.goal(fixture.id, { objective: 'Verify approved recovery transactions', acceptanceCriteria: ['transaction commit works'] });
  await engineering.requestReview(fixture.id);
  await engineering.approveReview(fixture.id, { approvedBy: 'test-owner' });
  const port = await freePort();
  let dashboardPort = await freePort();
  while (dashboardPort === port) dashboardPort = await freePort();
  await fs.writeFile(path.join(dataDir, '.env'), '');
  const localControlToken = 'test-local-control-token-0123456789abcdef';
  const child = spawn(process.execPath, ['server.mjs', '--no-auth'], {
    cwd: root,
    env: { ...process.env, MCP_DATA_DIR: dataDir, MCP_ACCESS_PROMPT_TOKEN: localControlToken, ALLOWED_ROOT: root, PORT: String(port), DASHBOARD_PORT: String(dashboardPort), NO_AUTH: '1', ADVANCED_TOOLS: '1' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errorOutput = '';
  child.stderr.on('data', (chunk) => { errorOutput += chunk.toString('utf8'); });
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await response.json();
    if (!response.ok || body.error || body.result?.isError) throw new Error(`${name}: ${JSON.stringify(body)}`);
    return JSON.parse(body.result.content.find((item) => item.type === "text")?.text || "{}");
  };
  try {
    await waitForServer(`http://127.0.0.1:${port}/`, child, () => errorOutput);
    const setMode = async (mode) => {
      const response = await fetch(`http://127.0.0.1:${dashboardPort}/dashboard/api/terminal/settings`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forgelink-local-control': localControlToken }, body: JSON.stringify({ mode }),
      });
      const responseText = await response.text();
      assert.equal(response.ok, true, responseText);
    };
    await setMode('safe');
    const started = await call('job_start_project', { task: 'git-status', cwd: root });
    assert.match(started.jobId, /^[0-9a-f-]{36}$/);
    const finished = await call('job_wait', { jobId: started.jobId, timeoutSeconds: 10 });
    assert.equal(finished.status, 'completed');
    const output = await call('job_output', { jobId: started.jobId });
    assert.match(output.stdout.text, /##|\?\?/);
    const events = await call('events_history', {});
    assert.equal(events.events.some((event) => event.type === 'job.completed' && event.jobId === started.jobId), true);
    await assert.rejects(call('job_start_terminal', { command: 'echo forbidden', cwd: root }), /Full Headless Terminal is disabled/);
    await setMode('full');
    const shells = await call('terminal_shells', {});
    const shell = process.platform === 'win32' ? 'cmd' : 'sh';
    assert.ok(shells.shells.includes(shell));
    const session = await call('terminal_create_session', { shell, cwd: root, cols: 80, rows: 24 });
    const attached = await call('terminal_attach', { sessionId: session.sessionId });
    await call('terminal_input', { sessionId: session.sessionId, text: 'echo FORGELINK_PTY_READY', enter: true });
    let transcript = '';
    const outputDeadline = Date.now() + 5000;
    while (Date.now() < outputDeadline && !transcript.includes('FORGELINK_PTY_READY')) {
      const output = await call('terminal_read_output', { sessionId: session.sessionId, attachmentId: attached.attachmentId });
      transcript += output.text;
      if (!transcript.includes('FORGELINK_PTY_READY')) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(transcript, /FORGELINK_PTY_READY/);
    const snapshot = await call('terminal_snapshot', { sessionId: session.sessionId });
    assert.equal(snapshot.pty, true);
    assert.match(snapshot.output.text, /FORGELINK_PTY_READY/);
    assert.equal((await call('terminal_resize', { sessionId: session.sessionId, cols: 100, rows: 30 })).cols, 100);
    const reconnected = await call('terminal_reconnect', { sessionId: session.sessionId, attachmentId: attached.attachmentId });
    assert.notEqual(reconnected.attachmentId, attached.attachmentId);
    assert.equal((await call('terminal_detach', { sessionId: session.sessionId, attachmentId: reconnected.attachmentId })).detached, true);
    assert.ok(['closing', 'closed'].includes((await call('terminal_close', { sessionId: session.sessionId })).status));
    const downgraded = await call('terminal_create_session', { shell, cwd: root });
    const terminal = await call('job_start_terminal', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10', cwd: root });
    await setMode('safe');
    const sessionsAfterDowngrade = await call('terminal_list_sessions', {});
    assert.ok(['closing', 'closed'].includes(sessionsAfterDowngrade.sessions.find((item) => item.sessionId === downgraded.sessionId)?.status));
    await assert.rejects(call('terminal_input', { sessionId: downgraded.sessionId, text: 'echo forbidden', enter: true }), /Full terminal access is required/);
    const cancelled = await call('job_wait', { jobId: terminal.jobId, timeoutSeconds: 10 });
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(call('job_output', { jobId: terminal.jobId }), /Terminal access no longer permits/);

    const rootRequest = async (method) => {
      const response = await fetch(`http://127.0.0.1:${dashboardPort}/dashboard/api/roots`, {
        method, headers: { 'content-type': 'application/json', 'x-forgelink-local-control': localControlToken }, body: JSON.stringify({ path: dataDir }),
      });
      assert.equal(response.ok, true);
    };
    await rootRequest('POST');
    const discoveryRoot = path.join(dataDir, 'discovery-fixture');
    const discoveredProject = path.join(discoveryRoot, 'MeeraAI');
    await fs.mkdir(path.join(discoveredProject, '.git'), { recursive: true });
    await fs.writeFile(path.join(discoveredProject, 'package.json'), JSON.stringify({ name: 'meera-ai' }));
    await fs.writeFile(path.join(discoveredProject, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const firstSearch = await call('search_files', { path: discoveryRoot, pattern: '*meera*', maxEntries: 1, maxResults: 1, maxDepth: 2, prune: false });
    let search = firstSearch;
    const searchMatches = [...search.matches];
    for (let page = 0; page < 10 && search.nextCursor; page++) {
      search = await call('search_files', { cursor: search.nextCursor, maxEntries: 1, maxResults: 1 });
      searchMatches.push(...search.matches);
    }
    assert.ok(searchMatches.some((item) => item === discoveredProject));
    assert.equal((await call('find_files', { path: discoveryRoot, pattern: '*meera*', maxDepth: 2 })).matches.includes(discoveredProject), true);
    const partialSearch = await call('find_files', { path: discoveryRoot, pattern: '*absent*', maxScanEntries: 1, maxDepth: 2 });
    assert.equal(partialSearch.complete, false);
    assert.notEqual(partialSearch.status, 'not_found');
    assert.ok(partialSearch.nextCursor);
    assert.equal((await call('search_files', { cursor: partialSearch.nextCursor, cancel: true })).cancelled, true);
    assert.equal((await call('find_project', { path: discoveryRoot, query: 'MeeraAI' })).projects[0].path, discoveredProject);
    assert.equal((await call('discover_git_repositories', { path: discoveryRoot })).repositories[0].branch, 'main');
    assert.equal((await call('project_index', { action: 'remember', path: discoveredProject })).path, discoveredProject);
    assert.equal((await call('project_index', { action: 'set_alias', path: discoveredProject, alias: 'Meera' })).alias, 'Meera');
    assert.equal((await call('find_project', { query: 'Meera' })).source, 'index');
    assert.equal((await call('get_recent_projects', {})).projects.some((item) => item.path === discoveredProject), true);
    await call('agent_batch', { action: 'set_concurrency', concurrency: 15 });
    const batch = await call('agent_batch', { action: 'submit', workUnits: Array.from({ length: 15 }, (_, index) => ({ task: 'find_files', label: `scan-${index}`, arguments: { path: discoveryRoot, pattern: '*meera*', maxScanEntries: 100, maxTimeMs: 2000, maxResults: 2 } })) });
    assert.equal(batch.workUnits.length, 15);
    assert.equal((await call('agent_batch', { action: 'stats' })).concurrency, 15);
    for (const unit of batch.workUnits) {
      const result = await call('agent_batch', { action: 'wait', id: unit.id, waitMs: 5000 });
      assert.equal(result.state, 'completed');
      assert.equal(result.result.matches.includes(discoveredProject), true);
    }
    const capabilities = await call('capabilities_list', {});
    assert.equal(capabilities.capabilities.length, 25);
    assert.equal((await call('capabilities_versions', {})).capabilities.length, 25);
    assert.equal((await call('capability_check', { name: 'capability.discovery' })).status, 'ready');
    assert.equal((await call('dependency_bootstrap_plan', { name: 'diff.structured' })).missing.length, 0);
    assert.equal(typeof (await call('local_tools_list', {})).tools.node.available, 'boolean');
    assert.equal((await call('path_diagnostics', { command: 'node' })).command, 'node');
    const environment = await call('environment_snapshot', {});
    assert.deepEqual((await call('environment_diff', { beforeValues: environment.values })).changes, []);
    const profilePath = path.join(dataDir, 'profile.ps1');
    await fs.writeFile(profilePath, 'Set-Alias ll Get-ChildItem\nfunction Test-Profile { }\n$env:PATH += ";C:\\Tools"\n');
    assert.equal((await call('shell_profile_inspect', { path: profilePath })).aliases[0].name, 'll');
    assert.equal((await call('shell_aliases', { path: profilePath })).functions[0].name, 'Test-Profile');
    assert.equal((await call('local_service_health', { port: dashboardPort })).reachable, true);
    const logPath = path.join(dataDir, 'diagnostic.log');
    await fs.writeFile(logPath, '{"timestamp":"2026-09-25T00:00:00Z","level":"ERROR","message":"failed","requestId":"request_12345678"}\n');
    assert.equal((await call('parse_log', { path: logPath })).entries[0].level, 'ERROR');
    assert.equal((await call('logs_correlate', { paths: [logPath], requestId: 'request_12345678' })).matches.length, 1);
    assert.equal((await call('http_trace', { port: dashboardPort, pathname: '/dashboard/api/tools' })).status, 200);
    assert.ok(Array.isArray((await call('proxy_inspect', {})).proxies));
    assert.equal((await call('tls_inspect', { port: await freePort() })).reachable, false);
    assert.equal((await call('api_discover', { port: dashboardPort })).found, false);
    assert.equal((await call('capability_health', {})).capabilities.length, 25);
    assert.equal((await call('tool_describe', { name: 'parse_log' })).name, 'parse_log');
    assert.equal((await call('tool_describe', { name: 'parse_log' })).inputSchema.limit.type, 'number');
    assert.equal((await call('error_explain', { message: 'EADDRINUSE' })).errorCode, 'PORT_IN_USE');
    assert.ok(Array.isArray((await call('git_diff_structured', { path: root })).files));
    const generatedPath = path.join(dataDir, 'dist', 'generated.js');
    await fs.mkdir(path.dirname(generatedPath));
    await fs.writeFile(generatedPath, '// @generated\n');
    assert.equal((await call('file_generated_status', { path: generatedPath })).likelyGenerated, true);
    assert.equal((await call('file_source_hint', { path: generatedPath })).likelyGenerated, true);
    const envBaseline = await call('regression_capture', { kind: 'environment' });
    assert.deepEqual((await call('environment_regression_compare', { baselineId: envBaseline.id })).changes, []);
    const apiBaseline = await call('regression_capture', { kind: 'api', port: dashboardPort, pathname: '/dashboard/api/tools' });
    assert.equal((await call('api_regression_compare', { baselineId: apiBaseline.id })).same, true);
    assert.equal((await call('regression_list', {})).baselines.length, 2);
    assert.equal((await call('regression_delete', { baselineId: apiBaseline.id })).deleted, true);
    assert.equal((await call('regression_delete', { baselineId: envBaseline.id })).deleted, true);
    const testReport = path.join(dataDir, 'result.xml');
    await fs.writeFile(testReport, '<testsuite tests="2" failures="0"></testsuite>');
    const testBaseline = await call('regression_capture', { kind: 'test', path: testReport });
    await fs.writeFile(testReport, '<testsuite tests="2" failures="1"></testsuite>');
    assert.equal((await call('regression_compare', { baselineId: testBaseline.id })).same, false);
    await call('regression_delete', { baselineId: testBaseline.id });
    const screenshot = path.join(dataDir, 'baseline.png');
    await fs.writeFile(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=', 'base64'));
    const screenshotBaseline = await call('regression_capture', { kind: 'screenshot', path: screenshot });
    assert.equal((await call('regression_compare', { baselineId: screenshotBaseline.id })).same, true);
    await call('regression_delete', { baselineId: screenshotBaseline.id });
    const performanceBaseline = await call('regression_capture', { kind: 'performance', port: dashboardPort, pathname: '/dashboard/api/tools' });
    assert.equal((await call('regression_compare', { baselineId: performanceBaseline.id })).kind, 'performance');
    await call('regression_delete', { baselineId: performanceBaseline.id });
    const subscription = await call('events_subscribe', { types: ['file.*'] });
    const watch = await call('watch_create', { path: dataDir, recursive: false, includePatterns: ['*.watch-test'] });
    assert.equal((await call('watch_list', {})).watches.some((item) => item.watchId === watch.watchId), true);
    const beforeFile = await call('events_history', {});
    const streamController = new AbortController();
    let streamResponse;
    try {
      streamResponse = await fetch(`http://127.0.0.1:${dashboardPort}/dashboard/api/events/stream?afterId=${beforeFile.latestId}`, { signal: streamController.signal });
      assert.equal(streamResponse.ok, true);
      assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);
      const watchedPath = path.join(dataDir, 'created.watch-test');
      await fs.writeFile(watchedPath, 'hello');
      const observed = await call('events_next', { subscriptionId: subscription.subscriptionId, timeoutSeconds: 5 });
      assert.equal(observed.events.some((event) => event.path === watchedPath && event.type.startsWith('file.')), true);
      assert.equal((await call('events_history', { types: ['file.*'] })).events.some((event) => event.path === watchedPath), true);
      const reader = streamResponse.body.getReader();
      const streamDeadline = Date.now() + 5000;
      let streamText = '';
      while (Date.now() < streamDeadline && !streamText.includes(JSON.stringify(watchedPath))) {
        const remaining = streamDeadline - Date.now();
        const chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for dashboard event stream')), remaining)),
        ]);
        if (chunk.done) break;
        streamText += new TextDecoder().decode(chunk.value);
      }
      assert.match(streamText, /event: forgelink/);
      assert.equal(streamText.includes(JSON.stringify(watchedPath)), true);
    } finally {
      streamController.abort();
    }
    assert.equal((await call('watch_pause', { watchId: watch.watchId })).status, 'paused');
    assert.equal((await call('watch_resume', { watchId: watch.watchId })).status, 'active');
    assert.equal((await call('watch_stop', { watchId: watch.watchId })).status, 'stopped');
    assert.equal((await call('events_unsubscribe', { subscriptionId: subscription.subscriptionId })).unsubscribed, true);
    const transactionPath = path.join(dataDir, 'transaction-a.txt');
    const createdPath = path.join(dataDir, 'transaction-b.txt');
    await fs.writeFile(transactionPath, 'before');
    const checkpoint = await call('snapshot_create', { workspace: dataDir, paths: [transactionPath] });
    assert.equal((await call('snapshot_list', {})).snapshots.some((item) => item.id === checkpoint.id), true);
    const transaction = await call('transaction_begin', { workspace: dataDir });
    const preview = await call('transaction_preview', { transactionId: transaction.id, operations: [
      { kind: 'replace', path: transactionPath, oldText: 'before', newText: 'after' },
      { kind: 'write', path: createdPath, content: 'created' },
    ] });
    assert.equal(preview.changes.length, 2);
    assert.equal(await fs.readFile(transactionPath, 'utf8'), 'before');
    assert.equal((await call('transaction_apply', { transactionId: transaction.id })).status, 'applied');
    assert.equal((await call('transaction_commit', { transactionId: transaction.id })).status, 'committed');
    assert.equal(await fs.readFile(createdPath, 'utf8'), 'created');
    assert.equal((await call('operation_history', {})).operations.some((item) => item.id === transaction.id), true);
    assert.equal((await call('operation_undo', { operationId: transaction.id })).status, 'undone');
    await assert.rejects(fs.stat(createdPath), { code: 'ENOENT' });
    assert.equal((await call('operation_redo', { operationId: transaction.id })).status, 'committed');
    assert.equal((await call('snapshot_compare', { snapshotId: checkpoint.id })).changes.length, 1);
    await call('snapshot_restore', { snapshotId: checkpoint.id });
    assert.equal(await fs.readFile(transactionPath, 'utf8'), 'before');
    assert.equal((await call('snapshot_delete', { snapshotId: checkpoint.id })).deleted, true);
    const lock = await call('lock_acquire', { path: transactionPath, owner: 'integration-test' });
    await assert.rejects(call('write_file', { path: transactionPath, content: 'blocked' }), /locked/);
    assert.equal((await call('lock_release', { lockId: lock.lockId })).released, true);
    await setMode('full');
    const revocationWatch = await call('watch_create', { path: dataDir, recursive: false });
    const revoked = await call('job_start_terminal', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10', cwd: dataDir });
    await rootRequest('DELETE');
    assert.equal((await call('watch_list', {})).watches.some((item) => item.watchId === revocationWatch.watchId), false);
    const revokedStatus = await call('job_cancel', { jobId: revoked.jobId });
    assert.ok(['cancelling', 'cancelled'].includes(revokedStatus.status));
  } finally {
    child.kill();
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const resolved = path.resolve(dataDir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('forgelink-job-test-')) throw new Error('Refusing to remove an unexpected test directory');
    await fs.rm(resolved, { recursive: true, force: true });
  }
  assert.equal(errorOutput, '');
});
