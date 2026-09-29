import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = process.env.MCP_VERIFY_BUNDLED === '1' ? path.join(here, 'dist-backend', 'backend-entry.mjs') : path.join(here, 'server.mjs');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-access-test-'));
const allowedRoot = path.join(scratch, 'already-approved');
const requestedRoot = path.join(scratch, 'temporary-grant');
const dataDir = path.join(scratch, 'state');
await Promise.all([fs.mkdir(allowedRoot), fs.mkdir(requestedRoot), fs.mkdir(dataDir)]);
await fs.writeFile(path.join(requestedRoot, 'read-me.txt'), 'temporary read grant works');
await fs.writeFile(path.join(requestedRoot, 'read.ts'), 'export const visible = 1;\n');
await fs.writeFile(path.join(dataDir, 'access-config.json'), JSON.stringify({ allowedRoots: [allowedRoot], terminalMode: 'off' }));
await fs.writeFile(path.join(dataDir, '.env'), '# isolated access test; no credentials\n');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const [port, dashboardPort] = await Promise.all([freePort(), freePort()]);
const base = `http://127.0.0.1:${port}`;
const token = crypto.randomBytes(32).toString('hex');
const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(key|token|secret|password|credential|authorization)/i.test(key)));
let startupError = '';
let child;
function startChild() {
  startupError = '';
  child = spawn(process.execPath, [serverEntry, `--public-url=http://localhost:${port}`, '--no-auth'], {
    cwd: here,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...safeEnvironment, MCP_DATA_DIR: dataDir, MCP_ASSET_DIR: here, MCP_ACCESS_PROMPT_TOKEN: token, ALLOWED_ROOT: allowedRoot, PORT: String(port), DASHBOARD_PORT: String(dashboardPort), NO_AUTH: '1' },
  });
  child.stderr.on('data', (chunk) => { startupError = `${startupError}${chunk.toString('utf8')}`.slice(-4000); });
  return child;
}
async function stopChild() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  current.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    current.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Isolated access-test MCP server did not start: ${startupError.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')}`);
}

async function callTool(id, name, args) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  startChild();
  await waitReady();
  const listResponse = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/list', params: {} }) });
  const listed = (await listResponse.json()).result.tools;
  const { PERMISSION_UI_URI } = await import('./desktop/artifact-ui.mjs');
  const permissionUri = PERMISSION_UI_URI;
  for (const name of ['request_path_access', 'request_terminal_access', 'request_windows_control_access', 'request_security_maintenance']) {
    const descriptor = listed.find((tool) => tool.name === name);
    assert.ok(descriptor, `${name} must be visible to the model`);
    assert.equal(descriptor._meta?.ui?.resourceUri, permissionUri);
    assert.equal(descriptor._meta?.['openai/outputTemplate'], permissionUri);
    assert.deepEqual(descriptor._meta?.ui?.visibility, ['model', 'app']);
    assert.equal(descriptor.annotations?.destructiveHint, false);
    assert.ok(descriptor.outputSchema?.properties?.permissionRequest);
  }
  assert.deepEqual(listed.find((tool) => tool.name === 'resolve_chat_permission')?._meta?.ui?.visibility, ['app']);
  const cardResponse = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'resources/read', params: { uri: permissionUri } }) });
  const card = (await cardResponse.json()).result?.contents?.[0];
  assert.equal(card?.mimeType, 'text/html;profile=mcp-app');
  assert.match(card?.text || '', /ForgeLink Permission Approval/);
  assert.match(card?._meta?.['openai/widgetDescription'] || '', /Allow or Deny/);
  const { CODE_REVIEW_UI_URI } = await import('./desktop/code-review-ui.mjs');
  const reviewUri = CODE_REVIEW_UI_URI;
  const reviewDescriptor = listed.find((tool) => tool.name === 'code_change_review');
  assert.equal(reviewDescriptor?._meta?.ui?.resourceUri, reviewUri);
  assert.equal(reviewDescriptor?._meta?.['openai/outputTemplate'], reviewUri);
  for (const action of ['undo', 'redo']) {
    const descriptor = listed.find((tool) => tool.name === `code_review_${action}`);
    assert.deepEqual(descriptor?._meta?.ui?.visibility, ['app']);
    assert.equal(descriptor?.annotations?.destructiveHint, true);
  }
  const reviewResourceResponse = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 92, method: 'resources/read', params: { uri: reviewUri } }) });
  const reviewResource = (await reviewResourceResponse.json()).result?.contents?.[0];
  assert.equal(reviewResource?.mimeType, 'text/html;profile=mcp-app');
  assert.match(reviewResource?.text || '', /review-card/);
  const codeMain = path.join(allowedRoot, 'main.ts');
  const codeOther = path.join(allowedRoot, 'other.ts');
  await fs.writeFile(path.join(allowedRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' }, include: ['*.ts'] }));
  await fs.writeFile(codeMain, 'export function greet(name: string) { return name; }\n');
  await fs.writeFile(codeOther, "import { greet } from './main';\nexport const answer = greet('Ada');\n");
  const definition = await callTool(20, 'code_definition', { workspace: allowedRoot, path: codeOther, line: 2, column: 23 });
  assert.equal(definition.result?.isError, undefined, definition.result?.content?.[0]?.text);
  assert.ok(JSON.parse(definition.result.content[0].text).locations.some((item) => item.path === codeMain));
  const renamePreview = await callTool(21, 'code_rename_symbol', { workspace: allowedRoot, path: codeMain, line: 1, column: 17, newName: 'hello' });
  assert.equal(renamePreview.result?.isError, undefined, renamePreview.result?.content?.[0]?.text);
  assert.equal(JSON.parse(renamePreview.result.content[0].text).applied, false);
  assert.match(await fs.readFile(codeMain, 'utf8'), /function greet/);
  const rename = await callTool(22, 'code_rename_symbol', { workspace: allowedRoot, path: codeMain, line: 1, column: 17, newName: 'hello', apply: true });
  assert.equal(rename.result?.isError, undefined, rename.result?.content?.[0]?.text);
  const renameInfo = JSON.parse(rename.result.content[0].text);
  assert.equal(renameInfo.applied, true);
  assert.match(await fs.readFile(codeOther, 'utf8'), /hello\('Ada'\)/);
  const codeReview = await callTool(93, 'code_change_review', { operationId: renameInfo.transactionId });
  assert.equal(codeReview.result?.isError, undefined, codeReview.result?.content?.[0]?.text);
  const reviewed = codeReview.result?.structuredContent?.review;
  assert.equal(reviewed?.fileCount, 2);
  assert.equal(reviewed?.source, 'transaction_snapshots');
  assert.equal(reviewed?.undoAvailable, true);
  assert.ok(reviewed?.addedLines > 0 && reviewed?.removedLines > 0);
  assert.deepEqual(new Set(reviewed?.files?.map((file) => file.path)), new Set(['main.ts', 'other.ts']));
  const undoRename = await callTool(23, 'code_review_undo', { operationId: renameInfo.transactionId });
  assert.equal(undoRename.result?.isError, undefined, undoRename.result?.content?.[0]?.text);
  assert.equal(undoRename.result?.structuredContent?.status, 'undone');
  assert.match(await fs.readFile(codeMain, 'utf8'), /function greet/);
  const redoRename = await callTool(94, 'code_review_redo', { operationId: renameInfo.transactionId });
  assert.equal(redoRename.result?.isError, undefined, redoRename.result?.content?.[0]?.text);
  assert.equal(redoRename.result?.structuredContent?.status, 'committed');
  assert.match(await fs.readFile(codeMain, 'utf8'), /function hello/);
  const resetRename = await callTool(95, 'operation_undo', { operationId: renameInfo.transactionId });
  assert.equal(resetRename.result?.isError, undefined, resetRename.result?.content?.[0]?.text);
  const unusedImport = path.join(allowedRoot, 'unused.ts');
  await fs.writeFile(unusedImport, "import { greet } from './main';\nexport const value = 1;\n");
  const importPreview = await callTool(24, 'code_organize_imports', { workspace: allowedRoot, path: unusedImport });
  assert.equal(JSON.parse(importPreview.result.content[0].text).changed, true);
  const organized = await callTool(25, 'code_organize_imports', { workspace: allowedRoot, path: unusedImport, apply: true });
  assert.equal(organized.result?.isError, undefined, organized.result?.content?.[0]?.text);
  const organizeInfo = JSON.parse(organized.result.content[0].text);
  assert.equal(organizeInfo.applied, true);
  assert.doesNotMatch(await fs.readFile(unusedImport, 'utf8'), /import \{ greet \}/);
  const undoOrganize = await callTool(26, 'operation_undo', { operationId: organizeInfo.transactionId });
  assert.equal(undoOrganize.result?.isError, undefined, undoOrganize.result?.content?.[0]?.text);
  const request = await callTool(1, 'request_path_access', { path: requestedRoot, access: 'read', justification: 'Read the requested local project.' });
  assert.equal(request.result?.isError, undefined);
  const requestInfo = request.result.structuredContent?.permissionRequest;
  const requestChallenge = request.result._meta?.['forgelink/approvalChallenge'];
  assert.equal(requestInfo?.status, 'pending');
  assert.ok(requestChallenge && !JSON.stringify(requestInfo).includes(requestChallenge), 'the model-visible request must not contain its approval challenge');

  const endpoint = `${base.replace(`:${port}`, `:${dashboardPort}`)}/dashboard/api/access-requests`;
  const deniedPoll = await fetch(endpoint);
  assert.equal(deniedPoll.status, 403, 'approval queue must reject unauthenticated local callers');
  const pendingResponse = await fetch(endpoint, { headers: { 'x-forgelink-access-token': token } });
  assert.equal(pendingResponse.status, 200);
  const pending = await pendingResponse.json();
  assert.equal(pending.requests.length, 0, 'ChatGPT card requests must not trigger a second native prompt');
  const unauthorized = await callTool(29, 'resolve_chat_permission', { requestId: requestInfo.requestId, challenge: 'wrong'.repeat(10), decision: 'allow' });
  assert.equal(unauthorized.result?.isError, true);
  const readGrant = await callTool(30, 'resolve_chat_permission', { requestId: requestInfo.requestId, challenge: requestChallenge, decision: 'allow' });
  assert.equal(readGrant.result?.structuredContent?.permissionRequest?.status, 'approved');
  const genericDecision = await callTool(44, 'permission_request_status', { requestId: requestInfo.requestId });
  assert.equal(JSON.parse(genericDecision.result.content[0].text).status, 'approved');
  const status = await callTool(2, 'check_path_access_request', { requestId: requestInfo.requestId });
  assert.equal(JSON.parse(status.result.content[0].text).level, 'read');

  const read = await callTool(3, 'read_text_file', { path: path.join(requestedRoot, 'read-me.txt') });
  assert.equal(read.result?.isError, undefined, read.result?.content?.[0]?.text);
  assert.equal(read.result.content[0].text, 'temporary read grant works');
  const readOnlyCode = await callTool(27, 'code_symbols', { workspace: requestedRoot, path: path.join(requestedRoot, 'read.ts') });
  assert.equal(readOnlyCode.result?.isError, undefined, readOnlyCode.result?.content?.[0]?.text);
  const deniedCodeEdit = await callTool(28, 'code_rename_symbol', { workspace: requestedRoot, path: path.join(requestedRoot, 'read.ts'), line: 1, column: 14, newName: 'changed', apply: true });
  assert.equal(deniedCodeEdit.result?.isError, true, 'a read-only grant must not authorize semantic edits');
  const deniedWrite = await callTool(4, 'write_file', { path: path.join(requestedRoot, 'should-not-write.txt'), content: 'denied' });
  assert.equal(deniedWrite.result?.isError, true, 'read-only grants must not authorize writes');

  const writeRequest = await callTool(5, 'request_path_access', { path: requestedRoot, access: 'read_write', justification: 'The user requested a project edit.' });
  const writeInfo = writeRequest.result.structuredContent?.permissionRequest;
  assert.equal(writeInfo?.status, 'pending', JSON.stringify(writeInfo));
  const writeResolve = await callTool(31, 'resolve_chat_permission', { requestId: writeInfo.requestId, challenge: writeRequest.result._meta['forgelink/approvalChallenge'], decision: 'allow' });
  assert.equal(writeResolve.result?.structuredContent?.permissionRequest?.status, 'approved');
  const write = await callTool(6, 'write_file', { path: path.join(requestedRoot, 'approved-write.txt'), content: 'write grant works' });
  assert.equal(write.result?.isError, undefined, write.result?.content?.[0]?.text);
  assert.equal(await fs.readFile(path.join(requestedRoot, 'approved-write.txt'), 'utf8'), 'write grant works');
  const alreadyThere = await callTool(7, 'create_directory', { path: requestedRoot });
  assert.equal(alreadyThere.result?.isError, undefined, alreadyThere.result?.content?.[0]?.text);
  assert.match(alreadyThere.result.content[0].text, /^Directory already exists:/);
  const nestedDirectory = path.join(requestedRoot, 'nested', 'created-by-test');
  const createdDirectory = await callTool(8, 'create_directory', { path: nestedDirectory });
  assert.equal(createdDirectory.result?.isError, undefined, createdDirectory.result?.content?.[0]?.text);
  assert.equal((await fs.stat(nestedDirectory)).isDirectory(), true);

  const persistentRoot = path.join(scratch, 'persistent-read-only');
  await fs.mkdir(persistentRoot);
  await fs.writeFile(path.join(persistentRoot, 'read-me.txt'), 'persistent root survives restart');
  const persistentRequest = await callTool(9, 'request_path_access', { path: persistentRoot, access: 'read', persistent: true, justification: 'The user explicitly requested lasting read-only access.' });
  const persistentInfo = persistentRequest.result.structuredContent?.permissionRequest;
  assert.equal(persistentInfo.persistent, true);
  const persistentResolve = await callTool(32, 'resolve_chat_permission', { requestId: persistentInfo.requestId, challenge: persistentRequest.result._meta['forgelink/approvalChallenge'], decision: 'allow', acknowledgedRisk: true });
  assert.equal(persistentResolve.result?.structuredContent?.permissionRequest?.status, 'approved');
  const persistentWriteDenied = await callTool(10, 'write_file', { path: path.join(persistentRoot, 'should-not-write.txt'), content: 'denied' });
  assert.equal(persistentWriteDenied.result?.isError, true, 'persistent read-only roots must not authorize writes');

  const broadRequest = await callTool(33, 'request_path_access', { path: path.parse(scratch).root, access: 'read', justification: 'Exercise broad-root risk acknowledgment.' });
  const broadInfo = broadRequest.result?.structuredContent?.permissionRequest;
  assert.equal(broadInfo?.risk, 'high');
  const broadChallenge = broadRequest.result._meta?.['forgelink/approvalChallenge'];
  const unacknowledged = await callTool(34, 'resolve_chat_permission', { requestId: broadInfo.requestId, challenge: broadChallenge, decision: 'allow' });
  assert.equal(unacknowledged.result?.isError, true, 'a drive-root grant requires the second risk acknowledgment');
  const broadDenied = await callTool(35, 'resolve_chat_permission', { requestId: broadInfo.requestId, challenge: broadChallenge, decision: 'deny' });
  assert.equal(broadDenied.result?.structuredContent?.permissionRequest?.status, 'denied');

  const windowsRequest = await callTool(36, 'request_windows_control_access', { mode: 'read', justification: 'Exercise the short Windows observation lease.' });
  const windowsInfo = windowsRequest.result?.structuredContent?.permissionRequest;
  assert.equal(windowsInfo?.status, 'pending');
  const windowsGrant = await callTool(37, 'resolve_chat_permission', { requestId: windowsInfo.requestId, challenge: windowsRequest.result._meta['forgelink/approvalChallenge'], decision: 'allow' });
  assert.equal(windowsGrant.result?.structuredContent?.permissionRequest?.status, 'approved');
  const windowsStatus = await callTool(38, 'permission_status', {});
  assert.equal(JSON.parse(windowsStatus.result.content[0].text).windows.mode, 'read');
  const windowsRevoked = await callTool(39, 'revoke_permission', { kind: 'windows' });
  assert.equal(JSON.parse(windowsRevoked.result.content[0].text).status, 'revoked');
  const windowsAfter = await callTool(40, 'permission_status', {});
  assert.equal(JSON.parse(windowsAfter.result.content[0].text).windows.mode, 'off');

  await stopChild();
  startChild();
  await waitReady();
  const allowed = await callTool(11, 'list_allowed_directories', {});
  const allowedInfo = JSON.parse(allowed.result.content[0].text);
  assert.ok(allowedInfo.permanentReadOnly.includes(persistentRoot), 'the permanent root must be loaded after backend restart');
  assert.equal(allowedInfo.temporary.length, 0, 'temporary grants must not survive backend restart');
  const persistentRead = await callTool(12, 'read_text_file', { path: path.join(persistentRoot, 'read-me.txt') });
  assert.equal(persistentRead.result.content[0].text, 'persistent root survives restart');
  const persistentWriteAfterRestart = await callTool(13, 'write_file', { path: path.join(persistentRoot, 'still-denied.txt'), content: 'denied' });
  assert.equal(persistentWriteAfterRestart.result?.isError, true);
  const maintenanceRequest = await callTool(41, 'request_security_maintenance', { justification: 'Exercise the desktop handoff without activating it.' });
  const maintenanceInfo = maintenanceRequest.result?.structuredContent?.permissionRequest;
  assert.equal(maintenanceInfo?.risk, 'high');
  const maintenanceGrant = await callTool(42, 'resolve_chat_permission', { requestId: maintenanceInfo.requestId, challenge: maintenanceRequest.result._meta['forgelink/approvalChallenge'], decision: 'allow', acknowledgedRisk: true });
  assert.equal(maintenanceGrant.result?.structuredContent?.permissionRequest?.grant?.status, 'awaiting_desktop_enforcer');
  const handoffUrl = `${base.replace(`:${port}`, `:${dashboardPort}`)}/dashboard/api/security-maintenance-request`;
  assert.equal((await fetch(handoffUrl)).status, 403);
  const handoff = await (await fetch(handoffUrl, { headers: { 'x-forgelink-access-token': token } })).json();
  assert.equal(handoff.request?.requestId, maintenanceInfo.requestId);
  const maintenanceStatus = await callTool(43, 'permission_status', {});
  assert.equal(JSON.parse(maintenanceStatus.result.content[0].text).maintenance.active, false);
  console.log(JSON.stringify({ semanticCodeNavigation: 'passed', transactionalCodeRename: 'passed', transactionalImportOrganization: 'passed', temporaryReadGrant: 'passed', readOnlyWriteDenied: 'passed', explicitWriteGrant: 'passed', createDirectoryIsIdempotent: 'passed', createNestedDirectory: 'passed', approvalTokenRequired: 'passed', persistentReadOnlySurvivesRestart: 'passed', persistentReadOnlyWriteDenied: 'passed', temporaryGrantRevokedByRestart: 'passed', broadRootAcknowledgment: 'passed', windowsLeaseRevocation: 'passed', protectedMaintenanceHandoff: 'passed' }, null, 2));
} finally {
  await stopChild();
  await fs.rm(scratch, { recursive: true, force: true });
}
