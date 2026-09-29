import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const mainSource = fs.readFileSync(path.join(desktopDir, 'main.mjs'), 'utf8');
const rendererSource = fs.readFileSync(path.join(desktopDir, 'renderer', 'src', 'main.js'), 'utf8');
const viewerSource = fs.readFileSync(path.join(desktopDir, 'artifact-ui-client.js'), 'utf8');
const serverSource = fs.readFileSync(path.resolve(desktopDir, '..', 'server.mjs'), 'utf8');

test('protected-source maintenance approval is ChatGPT-first and desktop-enforced', () => {
  assert.match(viewerSource, /renderPermissionRequest/);
  assert.match(viewerSource, /resolve_chat_permission/);
  assert.match(viewerSource, /forgelink\/approvalChallenge/);
  assert.match(viewerSource, /acknowledgedRisk/);
  assert.match(viewerSource, /permission_status/);
  assert.match(viewerSource, /Only your choice in this card can grant it/);
  assert.match(viewerSource, /request\.kind === 'maintenance'/);

  assert.match(serverSource, /registerAppTool\(server, 'request_security_maintenance'/);
  assert.match(serverSource, /registerAppTool\(server, 'resolve_chat_permission'/);
  assert.match(serverSource, /permissionToolMeta\('Applying your decision…', 'Permission decision recorded', \['app'\]\)/);
  assert.match(serverSource, /PERMISSION_UI_URI/);
  assert.match(serverSource, /kind: 'maintenance'/);
  assert.match(serverSource, /FORGELINK PERMISSION SUSPENSION RULE/);
  assert.match(serverSource, /Do not ask the user to type "done"/);
  assert.match(serverSource, /card itself sends the owner's authenticated decision back into this same conversation/i);
  assert.match(viewerSource, /authenticated card-generated continuation in the same conversation/);
  assert.match(viewerSource, /sendPermissionContinuation/);
  assert.match(viewerSource, /automatic same-chat continuation/);
  assert.match(viewerSource, /status: 'activating'/);
  assert.match(viewerSource, /status: 'reconnecting'/);
  assert.match(viewerSource, /status: 'active'/);
  assert.match(viewerSource, /status: 'resumed'/);
  assert.match(viewerSource, /did not reconnect with protected maintenance within 20 seconds/);
  const maintenanceActivationWait = viewerSource.indexOf("if (authoritativeDecision === 'allow' && request.kind === 'maintenance')");
  const continuationAfterReconnect = viewerSource.indexOf('if (authoritativeDecision && !permissionActionError)');
  assert.ok(maintenanceActivationWait >= 0 && continuationAfterReconnect > maintenanceActivationWait, 'maintenance approval must reconnect before ChatGPT resumes');
  assert.match(viewerSource, /setTimeout\(resolve, 250\)/);

  assert.match(mainSource, /handleSecurityMaintenanceApproval/);
  assert.match(mainSource, /dashboard\/api\/security-maintenance-request/);
  assert.match(mainSource, /request\.status !== 'approved'/);
  assert.match(mainSource, /setLocalSecurityMaintenance\(true,\s*\{\s*automatic:\s*false/);
  assert.match(mainSource, /durationMs/);

  assert.match(mainSource, /Protected-source maintenance can only be enabled from the ForgeLink approval card in ChatGPT/);
  assert.doesNotMatch(mainSource, /title: 'Enable protected-source maintenance\?'/);

  assert.match(rendererSource, /Approve in ChatGPT/);
  assert.match(rendererSource, /This desktop app does not enable maintenance/);
  assert.doesNotMatch(rendererSource, />Enable 15 min</);

  assert.match(viewerSource, /MAINTENANCE_DURATION_OPTIONS/);
  assert.match(viewerSource, /permission-duration-pills/);
  assert.match(viewerSource, /15m/);
  assert.match(viewerSource, /30m/);
  assert.match(viewerSource, /1h/);
  assert.match(viewerSource, /5h/);
  assert.match(viewerSource, /15h/);
  assert.match(viewerSource, /1day/);
  assert.match(serverSource, /parseMaintenanceDurationMs/);
  assert.match(serverSource, /formatMaintenanceDurationLabel/);
});

test('desktop retains local emergency disable while ChatGPT owns enable consent', () => {
  assert.match(rendererSource, /Disable now/);
  assert.match(rendererSource, /setLocalSecurityMaintenance\(false\)/);
  assert.match(mainSource, /return await setLocalSecurityMaintenance\(false\)/);
});

test('maintenance restart preserves tunnel clients and synchronizes frontend maintenance banner', () => {
  assert.match(mainSource, /async function stopBackendOnly\(\)/);
  assert.match(mainSource, /await stopBackendOnly\(\)/);
  const ensureBackendStoppedFn = mainSource.slice(mainSource.indexOf('async function ensureBackendStoppedForMaintenance'), mainSource.indexOf('async function setLocalSecurityMaintenance'));
  assert.doesNotMatch(ensureBackendStoppedFn, /await stopRuntime\(\)/);
  assert.match(ensureBackendStoppedFn, /await stopBackendOnly\(\)/);
  assert.match(mainSource, /maintenance: localSecurityMaintenanceState\(\)/);

  assert.match(rendererSource, /function maintenanceBanner\(\)/);
  assert.match(rendererSource, /data-maintenance-countdown/);
  assert.match(rendererSource, /formatRemainingTime/);
  assert.match(rendererSource, /toggleMaintenanceBanner/);
  assert.match(rendererSource, /Protected Maintenance/);
  assert.match(rendererSource, /Reconnecting…/);
});

