import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:24024';
let nextId = 1;

async function rpc(method, params) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const listed = await rpc('tools/list', {});
const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
for (const name of ['request_path_access', 'request_terminal_access', 'request_windows_control_access', 'request_security_maintenance', 'resolve_chat_permission', 'permission_status', 'permission_request_status', 'revoke_permission']) {
  assert.ok(byName.has(name), `${name} is registered`);
}
assert.deepEqual(byName.get('resolve_chat_permission')._meta?.ui?.visibility, ['app']);
const permissionUri = 'ui://forgelink/permission-approval-v1.html';
for (const name of ['request_path_access', 'request_terminal_access', 'request_windows_control_access', 'request_security_maintenance']) {
  const descriptor = byName.get(name);
  assert.equal(descriptor.annotations?.readOnlyHint, false);
  assert.equal(descriptor.annotations?.destructiveHint, false, 'creating a pending request does not apply authority');
  assert.equal(descriptor._meta?.ui?.resourceUri, permissionUri);
  assert.equal(descriptor._meta?.['openai/outputTemplate'], permissionUri);
  assert.ok(descriptor.outputSchema?.properties?.permissionRequest);
  assert.match(descriptor.description || '', /FORGELINK PERMISSION SUSPENSION RULE/);
  assert.match(descriptor.description || '', /Do not ask the user to type "done"/);
}
assert.equal(byName.get('resolve_chat_permission')._meta?.ui?.resourceUri, permissionUri);
assert.equal(byName.get('resolve_chat_permission').annotations?.destructiveHint, true);
const card = await rpc('resources/read', { uri: permissionUri });
assert.ok(card.contents?.[0]?.text?.includes('ForgeLink Permission Approval'));
assert.equal(card.contents?.[0]?._meta?.['openai/widgetDescription']?.includes('Allow or Deny'), true);

const scope = process.cwd();
const requested = await call('request_path_access', { path: scope, access: 'read', justification: 'Integration test of the ChatGPT approval card.' });
assert.equal(requested.isError, undefined);
const request = requested.structuredContent?.permissionRequest;
const challenge = requested._meta?.['forgelink/approvalChallenge'];
assert.equal(request?.status, 'pending');
assert.ok(typeof challenge === 'string' && challenge.length >= 32);
assert.equal(JSON.stringify(requested.structuredContent).includes(challenge), false);
const invalid = await call('resolve_chat_permission', { requestId: request.requestId, challenge: 'wrong'.repeat(10), decision: 'allow' });
assert.equal(invalid.isError, true);
const approved = await call('resolve_chat_permission', { requestId: request.requestId, challenge, decision: 'allow' });
assert.equal(approved.structuredContent?.permissionRequest?.status, 'approved');
const requestStatus = JSON.parse((await call('permission_request_status', { requestId: request.requestId })).content[0].text);
assert.equal(requestStatus.status, 'approved');
const grantId = approved.structuredContent.permissionRequest.grant.grantId;
const status = await call('permission_status');
const statusData = JSON.parse(status.content[0].text);
assert.ok(statusData.folders.temporary.some((grant) => grant.grantId === grantId));
const revoked = await call('revoke_permission', { kind: 'folder', grantId });
assert.equal(revoked.isError, undefined);
const replay = await call('resolve_chat_permission', { requestId: request.requestId, challenge, decision: 'allow' });
assert.equal(replay.isError, true);

const terminal = await call('request_terminal_access', { mode: 'safe', justification: 'Test a temporary Guarded Terminal lease.' });
assert.equal(terminal.structuredContent?.permissionRequest?.status, 'pending');
const terminalApproved = await call('resolve_chat_permission', { requestId: terminal.structuredContent.permissionRequest.requestId, challenge: terminal._meta['forgelink/approvalChallenge'], decision: 'allow' });
assert.equal(terminalApproved.structuredContent?.permissionRequest?.status, 'approved');
const terminalStatus = JSON.parse((await call('permission_status')).content[0].text);
assert.equal(terminalStatus.terminal.mode, 'safe');
assert.equal(terminalStatus.terminal.savedMode, 'off');
await call('revoke_permission', { kind: 'terminal' });

console.log(JSON.stringify({ ok: true, toolDescriptors: true, hiddenChallenge: true, wrongChallengeDenied: true, folderApprovalAndRevocation: true, replayDenied: true, terminalLeaseAndRevocation: true }));
