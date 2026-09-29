import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, utilityProcess } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { normalizeTerminalMode, normalizeSystemControlMode, normalizeAutomationMode, redactSensitive } from './shared.mjs';
import { platformName } from './platform-runtime.mjs';
import { deriveRuntimeState } from './runtime-health.mjs';
import {
  LOCAL_SECURITY_MAINTENANCE_TTL_MS,
  applyLocalSecurityMaintenanceEnv,
  normalizeLocalSecurityMaintenanceState,
  parseMaintenanceDurationMs,
  formatMaintenanceDurationLabel,
} from './local-security-maintenance.mjs';
import {
  buildTunnelProfile,
  chooseNextHealthPort,
  maskConnection,
  normalizeConfiguration,
  normalizeSecrets,
  sanitizeConfiguration,
  validateConnectionInput,
} from './tunnel-connections.mjs';

const moduleDir = path.join(app.getAppPath(), '.vite', 'build');
const PORT = 24024;
const DASHBOARD_PORT = 24025;
const HEALTH_PORT = 24124;
const links = Object.freeze({
  tunnels: 'https://platform.openai.com/settings/organization/tunnels',
  keys: 'https://platform.openai.com/settings/organization/api-keys',
  chatgpt: 'https://chatgpt.com/#settings/Connectors',
  guide: 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels',
  github: 'https://github.com/viditshah5656/local-files-mcp',
});

let mainWindow;
let backendProcess;
const tunnelProcesses = new Map();
const tunnelRuntime = new Map();
let accessPromptToken;
let accessPromptTimer;
let accessPromptInProgress = false;
let maintenanceApprovalInProgress = false;
const approvedDriveRoots = new Set();
let runtimeStatus = { state: 'stopped', message: 'Ready to start', updatedAt: Date.now(), checkedAt: null, backend: { healthy: false }, connections: {} };
let runtimeHealthTimer;
let runtimeHealthInFlight = false;
let runtimeStartInFlight = false;
let activeStartPromise = null;
let backendUnhealthyChecks = 0;
let runtimeRecoveryAttempted = false;
let canonicalRuntimeActive = false;
let canonicalRuntimePid = null;
let canonicalRuntimeOwned = false;
let localSecurityMaintenance = { enabled: false, expiresAt: null, durationMs: null };
let localSecurityMaintenanceTimer;
let localSecurityMaintenanceChanging = false;
const isHeadless = process.argv.includes('--headless') || app.commandLine.hasSwitch('headless');
let isQuitting = false;
let cachedHeadlessBackground = false;
let cachedAutomationMode = isHeadless ? 'headless' : 'off';

if (squirrelStartup) app.quit();

function dataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function publicError(error) {
  return redactSensitive(error);
}

function loginItemQuery() {
  return process.platform === 'win32' ? { path: process.execPath } : {};
}

function linuxAutostartPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config');
  return path.join(configHome, 'autostart', 'forgelink.desktop');
}

function applyLinuxLaunchAtLogin(desired) {
  const autostart = linuxAutostartPath();
  if (desired) {
    fs.mkdirSync(path.dirname(autostart), { recursive: true });
    const executable = String(process.execPath).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const icon = path.join(process.resourcesPath, 'logo.png').replaceAll('\\', '\\\\');
    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      'Version=1.0',
      'Name=ForgeLink',
      `Exec="${executable}"`,
      `Icon=${icon}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      'Comment=Start ForgeLink when this Linux desktop session begins',
      '',
    ].join('\n');
    fs.writeFileSync(autostart, entry, { mode: 0o600 });
  } else {
    fs.rmSync(autostart, { force: true });
  }
  return {
    enabled: desired,
    effective: desired ? fs.existsSync(autostart) : !fs.existsSync(autostart),
    packaged: true,
    supported: true,
    path: autostart,
  };
}

function applyLaunchAtLogin(enabled) {
  const desired = enabled === true;
  const supported = ['win32', 'darwin', 'linux'].includes(process.platform);
  if (!app.isPackaged || !supported) {
    return { enabled: desired, effective: false, packaged: app.isPackaged, supported, path: null };
  }
  if (process.platform === 'linux') return applyLinuxLaunchAtLogin(desired);
  const registration = process.platform === 'win32'
    ? { openAtLogin: desired, path: process.execPath }
    : { openAtLogin: desired };
  app.setLoginItemSettings(registration);
  const effective = app.getLoginItemSettings(loginItemQuery()).openAtLogin === true;
  return { enabled: desired, effective, packaged: true, supported: true, path: process.execPath };
}

function localSecurityMaintenanceState() {
  return normalizeLocalSecurityMaintenanceState(localSecurityMaintenance);
}

function localSecurityMaintenanceMarkerPath() {
  return dataPath('local-security-maintenance.json');
}

function clearLocalSecurityMaintenanceTimer() {
  if (localSecurityMaintenanceTimer) clearTimeout(localSecurityMaintenanceTimer);
  localSecurityMaintenanceTimer = undefined;
}

async function persistLocalSecurityMaintenanceMarker() {
  const state = localSecurityMaintenanceState();
  if (!state.enabled) {
    await fsp.rm(localSecurityMaintenanceMarkerPath(), { force: true }).catch(() => {});
    return;
  }
  await writeJson(localSecurityMaintenanceMarkerPath(), {
    version: 1,
    enabled: true,
    expiresAt: state.expiresAt,
    durationMs: state.durationMs || LOCAL_SECURITY_MAINTENANCE_TTL_MS,
  });
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function scheduleLocalSecurityMaintenanceExpiry() {
  clearLocalSecurityMaintenanceTimer();
  const state = localSecurityMaintenanceState();
  if (!state.enabled || !state.expiresAt) return;
  const remaining = state.expiresAt - Date.now();
  if (remaining <= 0) {
    void setLocalSecurityMaintenance(false, { automatic: true }).catch((error) => {
      publishStatus('error', 'Protected-source maintenance could not auto-disable cleanly.', publicError(error));
    });
    return;
  }
  const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
  localSecurityMaintenanceTimer = setTimeout(() => {
    const currentState = localSecurityMaintenanceState();
    if (!currentState.enabled) return;
    if (currentState.expiresAt && currentState.expiresAt > Date.now()) {
      scheduleLocalSecurityMaintenanceExpiry();
    } else {
      void setLocalSecurityMaintenance(false, { automatic: true }).catch((error) => {
        publishStatus('error', 'Protected-source maintenance could not auto-disable cleanly.', publicError(error));
      });
    }
  }, delay);
  localSecurityMaintenanceTimer.unref?.();
}

async function dashboardBackendPid() {
  try {
    const response = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/dashboard/api/status`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    const payload = await response.json();
    const pid = Number(payload?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForBackendStopped(timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const backend = await probeMcpBackend(700);
    if (!backend.healthy) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function stopBackendOnly() {
  const ownedBackendPid = canonicalRuntimeOwned ? canonicalRuntimePid : null;
  canonicalRuntimeActive = false;
  canonicalRuntimePid = null;
  canonicalRuntimeOwned = false;
  if (ownedBackendPid) {
    if (process.platform === 'win32') {
      try { await stopPowerShellBackend(); } catch (error) { publishStatus('error', 'The local backend could not be stopped cleanly.', publicError(error)); }
    } else {
      try { process.kill(ownedBackendPid, 'SIGTERM'); } catch {}
    }
  }
  if (accessPromptTimer) clearInterval(accessPromptTimer);
  accessPromptTimer = undefined;
  accessPromptToken = undefined;
  if (backendProcess) {
    try { backendProcess.kill(); } catch {}
  }
  backendProcess = undefined;
  await ensureBackendPortsFree(2000);
}

async function ensureBackendStoppedForMaintenance() {
  const detectedPid = await dashboardBackendPid();
  await stopBackendOnly();
  let backend = await probeMcpBackend(900);
  if (backend.healthy) {
    if (process.platform === 'win32') {
      await stopPowerShellBackend();
    } else if (detectedPid) {
      try { process.kill(detectedPid, 'SIGTERM'); } catch {}
    }
  }
  if (!(await waitForBackendStopped())) {
    backend = await probeMcpBackend(900);
    if (backend.healthy) throw new Error('The existing ForgeLink backend is still running. Maintenance state was not changed.');
  }
}

async function setLocalSecurityMaintenance(enabled, { automatic = false, durationMs } = {}) {
  if (localSecurityMaintenanceChanging) throw new Error('A maintenance mode transition is already in progress.');
  const current = localSecurityMaintenanceState();
  if (enabled === current.enabled) return { ok: true, maintenance: current, status: runtimeStatus, automatic };

  localSecurityMaintenanceChanging = true;
  try {
    publishStatus('starting', enabled ? 'Activating protected-source maintenance…' : 'Ending protected-source maintenance…', 'Restarting backend safely while preserving active ChatGPT tunnels.');
    await ensureBackendStoppedForMaintenance();
    const effectiveDurationMs = enabled ? parseMaintenanceDurationMs(durationMs, LOCAL_SECURITY_MAINTENANCE_TTL_MS) : null;
    localSecurityMaintenance = enabled
      ? { enabled: true, expiresAt: Date.now() + effectiveDurationMs, durationMs: effectiveDurationMs }
      : { enabled: false, expiresAt: null, durationMs: null };
    await persistLocalSecurityMaintenanceMarker();
    scheduleLocalSecurityMaintenanceExpiry();

    const { config } = await loadConnectionState();
    let status = runtimeStatus;
    if (config.connections.some((connection) => connection.enabled)) status = await startRuntime();
    publishStatus(runtimeStatus.state, runtimeStatus.message, runtimeStatus.detail);
    return { ok: true, maintenance: localSecurityMaintenanceState(), status: runtimeStatus, automatic };
  } catch (error) {
    localSecurityMaintenance = { enabled: false, expiresAt: null, durationMs: null };
    clearLocalSecurityMaintenanceTimer();
    await persistLocalSecurityMaintenanceMarker();
    if (enabled) {
      try {
        const { config } = await loadConnectionState();
        if (config.connections.some((connection) => connection.enabled)) await startRuntime();
      } catch {}
    }
    publishStatus(runtimeStatus.state, runtimeStatus.message, runtimeStatus.detail);
    throw error;
  } finally {
    localSecurityMaintenanceChanging = false;
  }
}

async function clearStaleLocalSecurityMaintenanceOnStartup() {
  const marker = await readJson(localSecurityMaintenanceMarkerPath(), null);
  if (!marker?.enabled) return;
  localSecurityMaintenance = { enabled: false, expiresAt: null, durationMs: null };
  await fsp.rm(localSecurityMaintenanceMarkerPath(), { force: true }).catch(() => {});
  const detectedPid = await dashboardBackendPid();
  const backend = await probeMcpBackend(900);
  if (!backend.healthy) return;
  if (process.platform === 'win32') {
    try { await stopPowerShellBackend(); } catch {}
  } else if (detectedPid) {
    try { process.kill(detectedPid, 'SIGTERM'); } catch {}
  }
  await waitForBackendStopped();
}

function publishStatus(state, message, detail = '', health = {}) {
  runtimeStatus = {
    ...runtimeStatus,
    state,
    message,
    detail,
    updatedAt: Date.now(),
    maintenance: localSecurityMaintenanceState(),
    ...health,
  };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:status', runtimeStatus);
}

async function readJson(filename, fallback = null) {
  try { return JSON.parse(await fsp.readFile(filename, 'utf8')); } catch { return fallback; }
}

async function readBackendRestartStatus() {
  const candidates = [
    dataPath('.backend-restart-status.json'),
    path.join(app.getAppPath(), '.backend-restart-status.json'),
  ];
  for (const file of candidates) {
    const data = await readJson(file, null);
    if (data) return data;
  }
  return null;
}

async function writeJson(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, filename);
}

async function validateFolder(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Choose at least one folder.');
  const folder = await fsp.realpath(path.resolve(input));
  const stat = await fsp.stat(folder);
  if (!stat.isDirectory()) throw new Error(`${folder} is not a folder.`);
  return folder;
}

function isDriveRoot(folder) {
  const root = path.parse(folder).root;
  return Boolean(root) && root.toLowerCase() === folder.toLowerCase();
}

async function findLegacyConnectionState() {
  const appData = app.getPath('appData');
  const currentUserData = app.getPath('userData');
  const candidates = new Set([
    // Product/package names used by ForgeLink builds. A packaged install can
    // reuse the signed-in Windows user's existing encrypted profile without
    // ever copying that profile into the installer.
    'ForgeLink by Vidit Shah',
    'ForgeLink',
    'forgelink',
    // Historical names supported for one-time migration.
    'Local Files for ChatGPT',
    'Local Files Desktop',
    'local-files-desktop',
    'Local-Files-for-ChatGPT',
  ]);
  const looksLikeForgeLinkProfile = (name) =>
    /^(?:forgelink(?:[ _-].*)?|local[ _-]?files(?:[ _-].*)?)$/i.test(String(name || '').trim());
  try {
    for (const entry of await fsp.readdir(appData, { withFileTypes: true })) {
      // Do not inspect arbitrary applications in AppData. Discovery is scoped
      // to ForgeLink and its historical product names only.
      if (entry.isDirectory() && looksLikeForgeLinkProfile(entry.name)) candidates.add(entry.name);
    }
  } catch {}
  for (const name of candidates) {
    const legacyDir = path.join(appData, name);
    if (path.resolve(legacyDir).toLowerCase() === path.resolve(currentUserData).toLowerCase()) continue;
    const legacyConfig = await readJson(path.join(legacyDir, 'desktop-config.json'), null);
    const normalized = normalizeConfiguration(legacyConfig);
    if (normalized.connections.length) {
      const legacySecrets = await readJson(path.join(legacyDir, 'desktop-secrets.json'), null);
      return { config: normalized, secrets: normalizeSecrets(legacySecrets, normalized.connections), source: legacyDir };
    }
  }

  // The previous standalone tunnel launcher stored the tunnel profile here.
  // It never stored the API key in this YAML, so the imported profile will
  // deliberately require the key to be entered once in the ForgeLink UI.
  const legacyProfilePath = path.join(appData, 'tunnel-client', 'local-files.yaml');
  try {
    const profile = await fsp.readFile(legacyProfilePath, 'utf8');
    const tunnelId = profile.match(/tunnel_id:\s*["']?([^"'\r\n]+)/)?.[1]?.trim();
    if (tunnelId) {
      const connection = {
        id: 'primary',
        name: 'Existing ChatGPT account',
        tunnelId,
        healthPort: 24124,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      return {
        config: normalizeConfiguration({ version: 2, connections: [connection] }),
        secrets: normalizeSecrets({ version: 2, connections: {} }, [connection]),
        source: path.join(appData, 'tunnel-client'),
      };
    }
  } catch {}

  return null;
}

async function readLegacyRuntimeKey() {
  const keyCandidates = [
    path.join(app.getPath('appData'), 'tunnel-client', 'api-key.dpapi'),
    path.join(os.homedir(), '.mcp-filesystem-chatgpt', 'tunnel-client-data', 'api-key.dpapi'),
    path.join(app.getAppPath(), 'tunnel-client-data', 'api-key.dpapi'),
  ];
  const keyFile = keyCandidates.find((candidate) => fs.existsSync(candidate));
  if (!keyFile) return '';
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', '-',
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FORGELINK_LEGACY_KEY_FILE: keyFile } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || 'Could not decrypt the legacy runtime key.')));
      child.stdin.end('$ErrorActionPreference="Stop"; $s=ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $env:FORGELINK_LEGACY_KEY_FILE).Trim()); $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }');
    });
    return String(result || '').trim();
  } catch (error) {
    try {
      await fsp.writeFile(
        dataPath('tunnel-client-data', 'runtime-key-migration.log'),
        JSON.stringify({ at: new Date().toISOString(), keyFile, error: String(error?.message || error || 'unknown') }) + '\\n',
        { mode: 0o600 },
      );
    } catch {}
    return '';
  }
}

async function loadConnectionState() {
  let rawConfig = await readJson(dataPath('desktop-config.json'), null);
  let rawSecrets = await readJson(dataPath('desktop-secrets.json'), null);
  let config = normalizeConfiguration(rawConfig);
  cachedHeadlessBackground = config.headlessBackground === true;
  cachedAutomationMode = isHeadless ? 'headless' : normalizeAutomationMode(config.automationMode);
  let secrets = normalizeSecrets(rawSecrets, config.connections);

  // ForgeLink was renamed from the previous desktop app. Preserve the old
  // tunnel/account profile automatically instead of presenting a blank setup.
  if (!config.connections.length) {
    const legacy = await findLegacyConnectionState();
    if (legacy) {
      config = legacy.config;
      secrets = legacy.secrets;
      rawConfig = null;
      rawSecrets = null;
      await writeJson(dataPath('desktop-config.json'), config);
      await writeJson(dataPath('desktop-secrets.json'), secrets);
    }
  }

  // The old setup stored the runtime key as a Windows DPAPI SecureString.
  // Migrate that credential into Electron safeStorage once, without ever
  // writing the plaintext key to disk or exposing it to the renderer.
  if (config.connections.length) {
    let migratedAny = false;
    for (const connection of config.connections) {
      if (!secrets.connections?.[connection.id]?.apiKey) {
        const legacyKey = await readLegacyRuntimeKey();
        if (legacyKey && safeStorage.isEncryptionAvailable()) {
          secrets.connections[connection.id] = {
            ...(secrets.connections[connection.id] || {}),
            apiKey: safeStorage.encryptString(legacyKey).toString('base64'),
          };
          migratedAny = true;
        }
      }
    }
    if (migratedAny) {
      await writeJson(dataPath('desktop-secrets.json'), secrets);
    }
  }

  const needsConfigMigration = JSON.stringify(rawConfig) !== JSON.stringify(config);
  const needsSecretMigration = JSON.stringify(rawSecrets) !== JSON.stringify(secrets);
  if (needsConfigMigration && rawConfig !== null) await writeJson(dataPath('desktop-config.json'), config);
  if (needsSecretMigration && rawSecrets !== null) await writeJson(dataPath('desktop-secrets.json'), secrets);
  return { config, secrets };
}

async function loadConfiguration() {
  return (await loadConnectionState()).config;
}

function runtimeIsActive() {
  return ['starting', 'running', 'degraded'].includes(runtimeStatus.state);
}

function safeConnectionLogName(id) {
  return String(id || 'connection').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (available) => {
      try { server.close(); } catch {}
      resolve(available);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    server.listen(port, '127.0.0.1');
  });
}

async function chooseHealthPort(configConnections, preferredPort, reservedPorts) {
  if (Number.isInteger(preferredPort) && !reservedPorts.has(preferredPort) && await isPortAvailable(preferredPort)) return preferredPort;
  const next = chooseNextHealthPort(configConnections, reservedPorts);
  if (await isPortAvailable(next)) return next;
  for (let port = next + 1; port <= 24223; port += 1) {
    if (reservedPorts.has(port)) continue;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error('No free local health port is available for another tunnel.');
}

async function saveSharedConfiguration(input) {
  const { config } = await loadConnectionState();
  const roots = [];
  for (const root of Array.isArray(input?.roots) ? input.roots : []) roots.push(await validateFolder(root));
  const uniqueRoots = [...new Map(roots.map((root) => [process.platform === 'win32' ? root.toLowerCase() : root, root])).values()];
  if (!uniqueRoots.length) throw new Error('Choose at least one folder for ChatGPT.');
  const previousAccess = await readJson(dataPath('access-config.json'), {});
  const rootKey = (root) => process.platform === 'win32' ? String(root).toLowerCase() : String(root);
  const selectedKeys = new Set(uniqueRoots.map(rootKey));
  const previousSetupKeys = new Set((Array.isArray(config.allowedRoots) ? config.allowedRoots : []).map(rootKey));
  for (const root of uniqueRoots) {
    if (isDriveRoot(root) && !previousSetupKeys.has(rootKey(root)) && !approvedDriveRoots.has(rootKey(root))) {
      throw new Error('To add an entire drive, select it in the native folder picker and confirm the whole-drive warning first.');
    }
  }
  const dynamicWriteRoots = (Array.isArray(previousAccess.allowedRoots) ? previousAccess.allowedRoots : []).filter((root) => !previousSetupKeys.has(rootKey(root)) && !selectedKeys.has(rootKey(root)));
  const dynamicReadOnlyRoots = (Array.isArray(previousAccess.readOnlyRoots) ? previousAccess.readOnlyRoots : []).filter((root) => !selectedKeys.has(rootKey(root)) && !dynamicWriteRoots.some((writeRoot) => rootKey(writeRoot) === rootKey(root)));
  const terminalMode = normalizeTerminalMode(input?.terminalMode);
  const systemControlMode = normalizeSystemControlMode(input?.systemControlMode ?? config.systemControlMode);
  const automationMode = normalizeAutomationMode(input?.automationMode ?? config.automationMode);
  const headlessBackground = input?.headlessBackground != null
    ? input.headlessBackground === true
    : config.headlessBackground === true;
  const nextConfig = {
    ...config,
    version: 2,
    allowedRoots: uniqueRoots,
    terminalMode,
    systemControlMode,
    automationMode,
    headlessBackground,
    launchAtLogin: input?.launchAtLogin === true,
  };
  cachedAutomationMode = automationMode;
  cachedHeadlessBackground = headlessBackground;
  const access = { allowedRoots: [...uniqueRoots, ...dynamicWriteRoots], readOnlyRoots: dynamicReadOnlyRoots, terminalMode, systemControlMode, automationMode };
  const wasRunning = runtimeIsActive();
  if (wasRunning) await stopRuntime();
  const password = crypto.randomBytes(32).toString('base64url');
  const env = `# Created by ForgeLink.\\nALLOWED_ROOT=${uniqueRoots[0]}\\nPORT=${PORT}\\nDASHBOARD_PORT=${DASHBOARD_PORT}\\nOAUTH_LOGIN_PASSWORD=${password}\\n`;
  await Promise.all([
    writeJson(dataPath('desktop-config.json'), nextConfig),
    writeJson(dataPath('access-config.json'), access),
    fsp.writeFile(dataPath('.env'), env, { mode: 0o600 }),
  ]);
  for (const root of uniqueRoots) approvedDriveRoots.delete(rootKey(root));
  applyLaunchAtLogin(nextConfig.launchAtLogin);
  if (wasRunning) await startRuntime();
  return { configuration: sanitizeConfiguration(nextConfig, Object.fromEntries(tunnelRuntime)) };
}

async function saveConnection(input) {
  const { config, secrets } = await loadConnectionState();
  const existing = config.connections.find((connection) => connection.id === String(input?.id || ''));
  const id = existing?.id || crypto.randomUUID();
  const existingSecret = secrets.connections?.[id]?.apiKey || '';
  const { name, tunnelId, apiKey } = validateConnectionInput(input, existingSecret);
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure system storage is not available. Sign in to your computer and try again.');

  const wasRunning = runtimeIsActive();
  if (wasRunning) await stopRuntime();
  const now = Date.now();
  const healthPort = existing?.healthPort || await chooseHealthPort(config.connections, undefined, new Set(config.connections.map((connection) => connection.healthPort)));
  const connection = {
    ...(existing || {}),
    id,
    name,
    tunnelId,
    healthPort,
    enabled: input?.enabled !== false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const nextConfig = {
    ...normalizeConfiguration(config),
    version: 2,
    connections: existing ? config.connections.map((item) => item.id === id ? connection : item) : [...config.connections, connection],
  };
  const nextSecrets = normalizeSecrets(secrets, nextConfig.connections);
  nextSecrets.connections[id] = {
    ...(nextSecrets.connections[id] || {}),
    ...(apiKey ? { apiKey: safeStorage.encryptString(apiKey).toString('base64') } : {}),
  };
  const profileDir = dataPath('tunnel-client-data', 'profiles');
  await fsp.mkdir(profileDir, { recursive: true });
  const profileName = `forge-${safeConnectionLogName(id)}`;
  await Promise.all([
    writeJson(dataPath('desktop-config.json'), nextConfig),
    writeJson(dataPath('desktop-secrets.json'), nextSecrets),
    fsp.writeFile(path.join(profileDir, `${profileName}.yaml`), buildTunnelProfile(connection, healthPort), { mode: 0o600 }),
  ]);
  if (wasRunning) {
    try { await startRuntime(); } catch (error) { publishStatus('error', `Saved ${name}, but the tunnel service did not fully reconnect.`, publicError(error)); }
  }
  return { configuration: sanitizeConfiguration(nextConfig, Object.fromEntries(tunnelRuntime)) };
}

async function deleteConnection(id) {
  const { config, secrets } = await loadConnectionState();
  const target = config.connections.find((connection) => connection.id === String(id || ''));
  if (!target) throw new Error('That ChatGPT connection no longer exists.');
  const wasRunning = runtimeIsActive();
  if (wasRunning) await stopRuntime();
  const nextConfig = { ...config, version: 2, connections: config.connections.filter((connection) => connection.id !== target.id) };
  const nextSecrets = normalizeSecrets(secrets, nextConfig.connections);
  delete nextSecrets.connections[target.id];
  const profilePath = path.join(dataPath('tunnel-client-data', 'profiles'), `forge-${safeConnectionLogName(target.id)}.yaml`);
  await Promise.all([
    writeJson(dataPath('desktop-config.json'), nextConfig),
    writeJson(dataPath('desktop-secrets.json'), nextSecrets),
    fsp.rm(profilePath, { force: true }),
  ]);
  if (wasRunning && nextConfig.connections.some((connection) => connection.enabled)) {
    try { await startRuntime(); } catch (error) { publishStatus('error', 'The remaining tunnel profiles were saved, but reconnection failed.', publicError(error)); }
  }
  return { configuration: sanitizeConfiguration(nextConfig, Object.fromEntries(tunnelRuntime)) };
}

async function setConnectionEnabled(id, enabled) {
  const { config } = await loadConnectionState();
  const target = config.connections.find((connection) => connection.id === String(id || ''));
  if (!target) throw new Error('That ChatGPT connection no longer exists.');
  const wasRunning = runtimeIsActive();
  if (wasRunning) await stopRuntime();
  const nextConfig = {
    ...config,
    version: 2,
    connections: config.connections.map((connection) => connection.id === target.id ? { ...connection, enabled: enabled === true, updatedAt: Date.now() } : connection),
  };
  await writeJson(dataPath('desktop-config.json'), nextConfig);
  if (wasRunning && nextConfig.connections.some((connection) => connection.enabled)) await startRuntime();
  return { configuration: sanitizeConfiguration(nextConfig, Object.fromEntries(tunnelRuntime)), status: runtimeStatus };
}

function tunnelBinaryPath() {
  const name = process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client';
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.resolve(app.getAppPath(), 'vendor', 'tunnel-client', `${process.platform}-${process.arch}`, name);
}

function serverScriptPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'backend-entry.mjs') : path.join(app.getAppPath(), 'server.mjs');
}

function lifecycleScriptPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'start-mcp.ps1') : path.join(app.getAppPath(), 'start-mcp.ps1');
}

function powerShellExecutable() {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'pwsh';
}

function backendLifecycleEnv(base = process.env) {
  const logs = dataPath('tunnel-client-data');
  fs.mkdirSync(logs, { recursive: true });
  return {
    ...base,
    FORGELINK_SERVER_SCRIPT: serverScriptPath(),
    FORGELINK_NODE_EXE: process.execPath,
    ELECTRON_RUN_AS_NODE: '1',
    FORGELINK_ENV_FILE: dataPath('.env'),
    FORGELINK_SERVER_OUT: path.join(logs, 'server.log'),
    FORGELINK_SERVER_ERR: path.join(logs, 'server.err.log'),
  };
}

async function writeBackendBootstrap(env) {
  const lifecycleEnv = backendLifecycleEnv(env);
  const keys = [
    'MCP_ACCESS_PROMPT_TOKEN','MCP_DATA_DIR','MCP_ASSET_DIR','PORT','DASHBOARD_PORT',
    'NO_AUTH','PUBLIC_URL','FORGELINK_SERVER_SCRIPT','FORGELINK_NODE_EXE',
    'ELECTRON_RUN_AS_NODE','FORGELINK_ENV_FILE','FORGELINK_SERVER_OUT','FORGELINK_SERVER_ERR',
    'FORGELINK_LOCAL_SECURITY_MAINTENANCE','FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT',
  ];
  const payload = Object.fromEntries(keys.filter((key) => lifecycleEnv[key] != null).map((key) => [key, String(lifecycleEnv[key])]));
  const file = dataPath(`backend-bootstrap-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  await fsp.writeFile(file, JSON.stringify(payload), { mode: 0o600 });
  return file;
}

function spawnPowerShellLifecycle(args, env, logName) {
  const script = lifecycleScriptPath();
  if (!fs.existsSync(script)) throw new Error('The ForgeLink PowerShell launcher is missing. Reinstall the application.');
  return spawnLogged(
    powerShellExecutable(),
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    backendLifecycleEnv(env),
    logName,
  );
}

function waitForProcessExit(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.off?.('error', onError);
      child?.off?.('exit', onExit);
      if (error) reject(error);
      else resolve(code);
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(null, code);
    child?.once?.('error', onError);
    child?.once?.('exit', onExit);
    const timer = setTimeout(() => finish(new Error('The ForgeLink PowerShell lifecycle command timed out.')), timeoutMs);
  });
}

async function waitForDashboardBackendPid(timeoutMs = 45000, shouldAbort = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort()) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/dashboard/api/status`, { signal: AbortSignal.timeout(1200) });
      if (response.ok) {
        const payload = await response.json();
        const pid = Number(payload.pid);
        if (Number.isInteger(pid) && pid > 0 && (await probeMcpBackend(1200)).healthy) return pid;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return null;
}

async function stopPowerShellBackend() {
  const bootstrapFile = await writeBackendBootstrap(process.env);
  try {
    const child = spawnPowerShellLifecycle(['-Stop', '-BootstrapFile', bootstrapFile], process.env, 'backend-stop');
    const code = await waitForProcessExit(child, 30000);
    if (code !== 0) throw new Error(`ForgeLink backend stop failed with exit code ${code ?? 'unknown'}.`);
  } finally {
    await fsp.rm(bootstrapFile, { force: true }).catch(() => {});
  }
}

function spawnLogged(file, args, env, logName) {
  const logs = dataPath('tunnel-client-data');
  fs.mkdirSync(logs, { recursive: true });
  const output = fs.openSync(path.join(logs, `${logName}.log`), 'a');
  const errors = fs.openSync(path.join(logs, `${logName}.err.log`), 'a');
  // In a packaged Electron app app.getAppPath() points inside app.asar,
  // which is not a valid Windows working directory for native child processes.
  // Use the unpacked resources directory so spawn() does not fail with ENOENT.
  const cwd = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', output, errors] });
  fs.closeSync(output);
  fs.closeSync(errors);
  return child;
}

function spawnBackend(env) {
  const logs = dataPath('tunnel-client-data');
  fs.mkdirSync(logs, { recursive: true });
  const output = fs.createWriteStream(path.join(logs, 'server.log'), { flags: 'a' });
  const errors = fs.createWriteStream(path.join(logs, 'server.err.log'), { flags: 'a' });
  const child = utilityProcess.fork(serverScriptPath(), ['--no-auth', `--public-url=http://localhost:${PORT}`], {
    env,
    stdio: 'pipe',
    serviceName: 'ForgeLink local backend',
  });
  child.stdout?.pipe(output);
  child.stderr?.pipe(errors);
  child.once('exit', () => { output.end(); errors.end(); });
  return child;
}

function ensureDevelopmentArtifactBundle() {
  if (app.isPackaged) return;
  const root = app.getAppPath();
  const source = path.join(root, 'desktop', 'artifact-ui-client.js');
  const bundle = path.join(root, 'desktop', 'artifact-ui-client.bundle.js');
  const sourceContents = fs.readFileSync(source);
  const bundleHeader = fs.existsSync(bundle) ? fs.readFileSync(bundle, 'utf8').slice(0, 256) : '';
  if (sourceContents.length === 0 && bundleHeader.includes('FORGELINK_SOURCE_SHA256:')) {
    console.warn('[ForgeLink] Artifact UI source is empty; keeping the last built bundle so the backend can start.');
    return;
  }
  const sourceHash = crypto.createHash('sha256').update(sourceContents).digest('hex');
  const marker = `FORGELINK_SOURCE_SHA256:${sourceHash}`;
  if (bundleHeader.includes(marker)) return;
  if (bundleHeader.includes('FORGELINK_SOURCE_SHA256:') && fs.statSync(bundle).mtimeMs > fs.statSync(source).mtimeMs) {
    console.warn('[ForgeLink] Artifact UI source is older than its built bundle; keeping the newer bundle.');
    return;
  }

  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-artifact-ui-native.mjs')], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not rebuild ForgeLink's artifact UI before starting the backend: ${result.error?.message || result.stderr?.trim() || `exit code ${result.status}`}`);
  }
}

async function ensureBackendPortsFree(timeoutMs = 5000) {
  if (backendProcess) {
    try { backendProcess.kill(); } catch {}
    backendProcess = undefined;
  }
  if (process.platform === 'win32') {
    for (const port of [PORT, DASHBOARD_PORT]) {
      try {
        const cmd = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
        const res = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 3000 });
        const pid = parseInt(res.stdout?.trim() || '', 10);
        if (pid && pid > 0 && pid !== process.pid) {
          spawnSync('taskkill.exe', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', timeout: 3000 });
        }
      } catch {}
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const b = await probeMcpBackend(200);
    const d = await probeLoopback('/dashboard/api/status', DASHBOARD_PORT, 200);
    if (!b.healthy && !d.healthy) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return true;
}

async function startBackendAsCurrentUser(env) {
  ensureDevelopmentArtifactBundle();
  await ensureBackendPortsFree();
  const child = spawnBackend(env);
  backendProcess = child;
  let exitCode = null;
  child.once('error', (error) => {
    publishStatus('error', 'The local service could not be launched.', publicError(error));
  });
  child.once('exit', async (code) => {
    exitCode = code;
    if (backendProcess === child) backendProcess = undefined;

    const restart = await readBackendRestartStatus();
    const isRestarting = restart &&
      ['requested', 'handoff_pending', 'waiting_for_old_process_exit', 'starting_new_process', 'waiting_for_ready'].includes(restart.status) &&
      (Date.now() - Date.parse(restart.at || 0) < 60000);

    if (isRestarting) {
      publishStatus('starting', 'Restarting ForgeLink backend…', 'ChatGPT Web initiated an in-place backend restart. Reconnecting refreshed backend…');
      const mcpReady = await waitForMcpBackend(35000);
      if (mcpReady) {
        canonicalRuntimeActive = true;
        canonicalRuntimeOwned = true;
        await reconcileRuntimeHealth({ force: true });
        publishStatus('running', 'ForgeLink is running normally', 'Backend refreshed and reconnected to ChatGPT Web.');
      }
      return;
    }

    if (runtimeIsActive()) publishStatus('error', 'The local service stopped unexpectedly.', `Exit code ${code ?? 'unknown'}`);
  });
  const pid = await waitForUtilityProcessPid(child, 5000);
  if (!pid) {
    try { child.kill(); } catch {}
    const exitDetail = exitCode == null ? '' : ` It exited with code ${exitCode}.`;
    throw new Error(`The local MCP process did not spawn successfully.${exitDetail} Check Logs & Diagnostics for server.err.log.`);
  }
  const ready = await waitFor(`http://127.0.0.1:${DASHBOARD_PORT}/dashboard/api/status`, (response, text) => {
    if (!response.ok) return false;
    try { return Number(JSON.parse(text).pid) === pid; } catch { return false; }
  }, 15000);
  const mcpReady = ready && await waitForMcpBackend(15000);
  if (!ready || !mcpReady) {
    try { child.kill(); } catch {}
    throw new Error(`The local MCP server did not answer MCP tools/list for PID ${pid}. Check Logs & Diagnostics for server.err.log.`);
  }
  return pid;
}

async function waitForUtilityProcessPid(child, timeoutMs = 5000) {
  const currentPid = Number(child?.pid);
  if (Number.isInteger(currentPid) && currentPid > 0) return currentPid;

  return await new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (pid) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child?.off?.('spawn', onSpawn);
      child?.off?.('exit', onExit);
      resolve(pid);
    };
    const onSpawn = () => {
      const pid = Number(child?.pid);
      finish(Number.isInteger(pid) && pid > 0 ? pid : null);
    };
    const onExit = () => finish(null);

    child?.once?.('spawn', onSpawn);
    child?.once?.('exit', onExit);
    timer = setTimeout(() => finish(null), timeoutMs);

    // Close the tiny race where spawn happened after the first check but
    // before the listeners above were attached.
    const pidAfterListeners = Number(child?.pid);
    if (Number.isInteger(pidAfterListeners) && pidAfterListeners > 0) finish(pidAfterListeners);
  });
}

async function waitFor(url, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      const text = await response.text();
      if (predicate(response, text)) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

async function probeLoopback(pathname, port, timeoutMs = 1400) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      headers: { accept: 'text/plain, application/json' },
    });
    const body = (await response.text()).replaceAll('"', '').trim();
    return {
      healthy: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      body: body.slice(0, 64),
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - startedAt,
      error: String(error?.name || error?.code || 'UNREACHABLE').slice(0, 64),
    };
  }
}

async function probeMcpBackend(timeoutMs = 1400) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'forgelink-health', method: 'tools/list', params: {} }),
      redirect: 'manual',
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
      if (dataLine) {
        try { payload = JSON.parse(dataLine.slice(5).trim()); } catch {}
      }
    }
    const tools = payload?.result?.tools;
    const healthy = response.ok && Array.isArray(tools) && !payload?.error;
    return {
      healthy,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      body: healthy ? `${tools.length} MCP tools` : 'MCP tools/list unavailable',
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - startedAt,
      error: String(error?.name || error?.code || 'UNREACHABLE').slice(0, 64),
    };
  }
}

async function waitForMcpBackend(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeMcpBackend()).healthy) return true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

async function reconcileRuntimeHealth({ force = false } = {}) {
  if (runtimeHealthInFlight) return runtimeStatus;
  runtimeHealthInFlight = true;
  try {
    const { config } = await loadConnectionState();

    const enabledConnections = config.connections.filter((connection) => connection.enabled);
    if (!enabledConnections.length) {
      if (force || runtimeStatus.state !== 'stopped') publishStatus('stopped', 'No enabled ChatGPT tunnel connections.', 'Add and enable a tunnel profile.');
      return runtimeStatus;
    }

    const backend = await probeMcpBackend();
    const checkedAt = new Date().toISOString();
    const connectionResults = await Promise.all(enabledConnections.map(async (connection) => {
      const current = tunnelRuntime.get(connection.id) || {};
      const healthPort = Number(current.healthPort || connection.healthPort);
      const health = await probeLoopback('/readyz', healthPort);
      const ready = health.healthy && health.body === 'ready';
      const next = {
        ...current,
        state: ready ? 'running' : (current.state === 'starting' ? 'starting' : 'stopped'),
        message: ready ? 'Connected securely' : 'Not connected',
        healthPort,
        name: connection.name,
        tunnelIdMasked: maskConnection(connection).tunnelIdMasked,
        checkedAt,
        latencyMs: health.latencyMs,
        healthStatus: health.status ?? null,
        ownership: tunnelProcesses.has(connection.id) ? 'managed' : 'detected',
      };
      tunnelRuntime.set(connection.id, next);
      return next;
    }));

    const live = connectionResults.filter((connection) => connection.state === 'running').length;
    const derived = deriveRuntimeState({
      backendHealthy: backend.healthy,
      liveConnections: live,
      enabledConnections: enabledConnections.length,
    });

    // Do not let a health poll turn an in-progress launch into "degraded" or
    // "stopped" while Windows elevation and the backend are still starting.
    if (runtimeStartInFlight || (runtimeStatus.state === 'starting' && Date.now() - (runtimeStatus.updatedAt || 0) < 20000)) return runtimeStatus;
    publishStatus(derived.state, derived.message, derived.detail, {
      checkedAt,
      backend: { healthy: backend.healthy, status: backend.status ?? null, latencyMs: backend.latencyMs },
      connections: Object.fromEntries(connectionResults.map((connection) => [connection.id, connection])),
    });
    if (backend.healthy) {
      backendUnhealthyChecks = 0;
      runtimeRecoveryAttempted = false;
    } else if (canonicalRuntimeActive && !runtimeRecoveryAttempted && ++backendUnhealthyChecks >= 3) {
      runtimeRecoveryAttempted = true;
      void startRuntime().catch((error) => publishStatus('error', 'The local backend could not be restored.', publicError(error)));
    }
    return runtimeStatus;
  } finally {
    runtimeHealthInFlight = false;
  }
}

function startRuntimeHealthMonitor() {
  if (runtimeHealthTimer) clearInterval(runtimeHealthTimer);
  runtimeHealthTimer = setInterval(() => { void reconcileRuntimeHealth(); }, 1500);
  void reconcileRuntimeHealth({ force: true });
}

function stopRuntimeHealthMonitor() {
  if (runtimeHealthTimer) clearInterval(runtimeHealthTimer);
  runtimeHealthTimer = undefined;
}

async function stopRuntime() {
  await stopBackendOnly();
  for (const child of tunnelProcesses.values()) {
    try { child.kill(); } catch {}
  }
  tunnelProcesses.clear();
  tunnelRuntime.clear();
  publishStatus('stopped', 'Service stopped', 'All configured tunnel clients are disconnected.', {
    checkedAt: new Date().toISOString(),
    backend: { healthy: false, status: null, latencyMs: null },
    connections: {},
  });
  return runtimeStatus;
}

async function handleAccessPrompt() {
  if (accessPromptInProgress || !accessPromptToken || !['running', 'degraded'].includes(runtimeStatus.state)) return;
  accessPromptInProgress = true;
  try {
    const headers = { 'x-forgelink-access-token': accessPromptToken };
    const response = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/dashboard/api/access-requests`, { headers, signal: AbortSignal.timeout(1500) });
    if (!response.ok) return;
    const { requests = [] } = await response.json();
    const request = requests[0];
    if (!request) return;

    const wholeDrive = request.isDriveRoot === true;
    const extraConfirmation = request.requiresExtraConfirmation === true;
    const operatingSystem = platformName(process.platform);
    const accessLabel = request.access === 'read_write' ? 'read and modify files' : 'read files';
    const persistentRequest = request.persistent === true;
    const detail = [
      `Requested folder: ${request.path}`,
      `Requested permission: ${accessLabel}`,
      persistentRequest ? 'The permanent option is saved on this computer and remains until removed in ForgeLink.' : 'If approved, access lasts 15 minutes and is not saved after the app closes.',
      'There is no background disk upload, but files ChatGPT explicitly reads can be sent through your ChatGPT session.',
      request.justification ? `ChatGPT says: ${request.justification}` : '',
      extraConfirmation ? `WARNING: This is a broad or system-sensitive location${wholeDrive ? ' (an entire drive root)' : ''}. It may contain personal files, browser data, application settings, or operating-system files. ${operatingSystem} still enforces this account’s file permissions.` : '',
    ].filter(Boolean).join('\n\n');
    const buttons = persistentRequest
      ? request.access === 'read_write'
        ? ['Deny', 'Allow read-only for 15 minutes', 'Allow read and modify for 15 minutes', 'Always allow read and modify']
        : ['Deny', 'Allow read-only for 15 minutes', 'Always allow read-only']
      : request.access === 'read_write'
        ? ['Deny', 'Allow read-only for 15 minutes', 'Allow read and modify for 15 minutes']
        : ['Deny', 'Allow read-only for 15 minutes'];
    const promptOptions = { type: extraConfirmation || persistentRequest ? 'warning' : 'question', title: 'ChatGPT is requesting folder access', message: persistentRequest ? 'Choose whether to grant lasting filesystem access.' : 'Approve this temporary filesystem permission?', detail, buttons, defaultId: 0, cancelId: 0, noLink: true };
    const choice = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, promptOptions)
      : await dialog.showMessageBox(promptOptions);
    let decision = 'deny';
    let persistent = false;
    if (persistentRequest) {
      if (request.access === 'read_write' && choice.response === 1) decision = 'read';
      if (request.access === 'read_write' && choice.response === 2) decision = 'read_write';
      if (request.access === 'read_write' && choice.response === 3) { decision = 'read_write'; persistent = true; }
      if (request.access === 'read' && choice.response === 1) decision = 'read';
      if (request.access === 'read' && choice.response === 2) { decision = 'read'; persistent = true; }
    } else {
      if (choice.response === 1) decision = 'read';
      if (choice.response === 2) decision = 'read_write';
    }

    if (extraConfirmation && decision !== 'deny') {
      const confirmed = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, { type: 'warning', title: wholeDrive ? 'Confirm whole-drive access' : 'Confirm broad folder access', message: `You are granting ${persistent ? 'persistent' : 'temporary'} ${decision === 'read_write' ? 'read and modify' : 'read-only'} access to ${request.path}.`, detail: `This may expose a broad set of private or operating-system files to ChatGPT through the selected tools. ${persistent ? 'The grant will be saved on this computer until removed in ForgeLink.' : 'The grant expires after 15 minutes.'} Continue only if you understand and want this access.`, buttons: ['Cancel', wholeDrive ? 'Confirm whole-drive access' : 'Confirm broad access'], defaultId: 0, cancelId: 0, noLink: true })
        : await dialog.showMessageBox({ type: 'warning', title: wholeDrive ? 'Confirm whole-drive access' : 'Confirm broad folder access', message: `You are granting ${persistent ? 'persistent' : 'temporary'} ${decision === 'read_write' ? 'read and modify' : 'read-only'} access to ${request.path}.`, detail: `This may expose a broad set of private or operating-system files to ChatGPT through the selected tools. ${persistent ? 'The grant will be saved on this computer until removed in ForgeLink.' : 'The grant expires after 15 minutes.'} Continue only if you understand and want this access.`, buttons: ['Cancel', wholeDrive ? 'Confirm whole-drive access' : 'Confirm broad access'], defaultId: 0, cancelId: 0, noLink: true });
      if (confirmed.response !== 1) decision = 'deny';
    }

    await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/dashboard/api/access-requests/${encodeURIComponent(request.id)}/resolve`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ decision, persistent }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Requests expire automatically; keep the local owner-facing prompt loop alive.
  } finally {
    accessPromptInProgress = false;
  }
}

async function handleSecurityMaintenanceApproval() {
  if (maintenanceApprovalInProgress || !accessPromptToken || !['running', 'degraded'].includes(runtimeStatus.state)) return;
  if (localSecurityMaintenanceState().enabled) return;

  maintenanceApprovalInProgress = true;
  try {
    const headers = { 'x-forgelink-access-token': accessPromptToken };
    const response = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/dashboard/api/security-maintenance-request`, {
      headers,
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return;
    const payload = await response.json();
    const request = payload?.request;
    if (!request || request.status !== 'approved') return;

    const rawDuration = request.durationMs ?? request.grant?.durationMs ?? request.duration ?? (request.durationMinutes ? request.durationMinutes * 60_000 : undefined);
    const durationMs = parseMaintenanceDurationMs(rawDuration, LOCAL_SECURITY_MAINTENANCE_TTL_MS);

    await setLocalSecurityMaintenance(true, { automatic: false, durationMs });
  } catch {
    // Older backends do not expose the ChatGPT maintenance handoff endpoint.
    // Once the protected bootstrap is installed, an approved request is consumed
    // here by the local desktop enforcer and the runtime restarts into maintenance.
  } finally {
    maintenanceApprovalInProgress = false;
  }
}

function startAccessPromptPolling() {
  if (accessPromptTimer) clearInterval(accessPromptTimer);
  accessPromptTimer = setInterval(() => {
    void handleAccessPrompt();
    void handleSecurityMaintenanceApproval();
  }, 1000);
  void handleAccessPrompt();
  void handleSecurityMaintenanceApproval();
}

async function detectExistingTransport() {
  // A backend and its tunnels are separate processes. Detect the backend
  // independently so a manually-started (or previously adopted) backend does
  // not prevent ForgeLink from starting the configured tunnels itself.
  //
  // ForgeLink owns the backend whenever it starts it. If another compatible
  // backend is already listening, we adopt it rather than creating a second
  // server on the same ports.
  const backend = await probeMcpBackend();
  if (!backend.healthy) return null;

  const tunnel = await probeLoopback('/readyz', HEALTH_PORT);
  canonicalRuntimeActive = true;
  canonicalRuntimePid = null;
  canonicalRuntimeOwned = false;
  return {
    backend: { healthy: true, status: backend.status, latencyMs: backend.latencyMs },
    tunnel: tunnel.healthy && tunnel.body === 'ready'
      ? { healthPort: HEALTH_PORT, ready: true, status: tunnel.status }
      : { healthPort: HEALTH_PORT, ready: false, status: tunnel.status ?? null },
    ownership: 'detected',
  };
}

async function startRuntime() {
  if (activeStartPromise) {
    return await activeStartPromise;
  }
  if (runtimeStatus.state === 'running' && (await probeMcpBackend()).healthy) return runtimeStatus;
  runtimeStartInFlight = true;
  activeStartPromise = (async () => {
    try {
      return await startRuntimeWithLock();
    } catch (error) {
      publishStatus('error', publicError(error));
      throw error;
    } finally {
      runtimeStartInFlight = false;
      activeStartPromise = null;
    }
  })();
  return await activeStartPromise;
}

async function startRuntimeWithLock() {
  // A reachable tunnel does not mean the MCP backend is running. The health
  // monitor reports that combination as degraded, and repair must continue.
  if (runtimeStatus.state === 'running' && (await probeMcpBackend()).healthy) return runtimeStatus;
  const { config, secrets } = await loadConnectionState();
  const enabledConnections = config.connections.filter((connection) => connection.enabled);
  if (!enabledConnections.length) throw new Error('Add and enable at least one ChatGPT tunnel connection first.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure system storage is not available. Sign in to your computer and try again.');
  const client = tunnelBinaryPath();
  if (!fs.existsSync(client)) throw new Error('The secure tunnel component is missing. Reinstall the application.');

  // First detect an already-running backend. The backend is shared by all
  // ChatGPT accounts; each configured tunnel is still started independently
  // below. This is the key lifecycle rule: opening ForgeLink is sufficient.
  const detectedTransport = await detectExistingTransport();
  let existingCanonical = detectedTransport?.tunnel?.ready
    ? enabledConnections.find((connection) => Number(connection.healthPort) === HEALTH_PORT) || enabledConnections[0]
    : null;

  let backendRunsAsCurrentUser = false;

  if (!detectedTransport) {
    await stopBackendOnly();
    publishStatus('starting', `Starting ForgeLink with ${enabledConnections.length} ChatGPT tunnel${enabledConnections.length === 1 ? '' : 's'}…`);
    accessPromptToken = crypto.randomBytes(32).toString('hex');
    const commonEnv = applyLocalSecurityMaintenanceEnv({ ...process.env, MCP_ACCESS_PROMPT_TOKEN: accessPromptToken, MCP_DATA_DIR: app.getPath('userData'), MCP_ASSET_DIR: app.isPackaged ? process.resourcesPath : app.getAppPath(), PORT: String(PORT), DASHBOARD_PORT: String(DASHBOARD_PORT), NO_AUTH: '1', PUBLIC_URL: `http://localhost:${PORT}` }, localSecurityMaintenanceState());
    delete commonEnv.OPENAI_API_KEY;
    // Older packaged backend bundles expect the desktop .env file to exist even
    // though the runtime configuration is supplied through the child environment.
    // Keep the app self-healing so a migrated/install-existing profile can start
    // without requiring the user to save the connection again.
    const desktopEnvPath = dataPath('.env');
    if (!fs.existsSync(desktopEnvPath)) {
      const primaryRoot = config.allowedRoots?.[0] || (process.platform === 'win32' ? 'C:\\\\Coding' : process.cwd());
      await fsp.writeFile(
        desktopEnvPath,
        `# ForgeLink managed runtime configuration.\nALLOWED_ROOT=${primaryRoot}\nPORT=${PORT}\nDASHBOARD_PORT=${DASHBOARD_PORT}\nNO_AUTH=1\nPUBLIC_URL=http://localhost:${PORT}\n`,
        { mode: 0o600 },
      );
    }
    let backendPid;
    try {
      backendPid = await startBackendAsCurrentUser(commonEnv);
      backendRunsAsCurrentUser = true;
    } catch (directError) {
      if (process.platform === 'win32') {
        const bootstrapFile = await writeBackendBootstrap(commonEnv);
        try {
          backendProcess = spawnPowerShellLifecycle(['-LocalOnly', '-BootstrapFile', bootstrapFile], commonEnv, 'backend-launcher');
          const launcher = backendProcess;
          let launcherExitCode = null;
          launcher.once('exit', (code) => { launcherExitCode = code; });
          backendPid = await waitForDashboardBackendPid(10000, () => launcherExitCode !== null);
        } finally {
          await fsp.rm(bootstrapFile, { force: true }).catch(() => {});
        }
        if (!backendPid) throw directError;
      } else {
        throw directError;
      }
    }

    canonicalRuntimeActive = true;
    canonicalRuntimePid = backendPid;
    canonicalRuntimeOwned = true;
    const survivingTunnel = await probeLoopback('/readyz', HEALTH_PORT);
    if (survivingTunnel.healthy && survivingTunnel.body === 'ready') {
      existingCanonical = enabledConnections.find((connection) => Number(connection.healthPort) === HEALTH_PORT) || enabledConnections[0];
      tunnelRuntime.set(existingCanonical.id, {
        state: 'running',
        message: 'Connected securely',
        healthPort: HEALTH_PORT,
        tunnelIdMasked: maskConnection(existingCanonical).tunnelIdMasked,
        name: existingCanonical.name,
        ownership: 'detected',
        checkedAt: new Date().toISOString(),
      });
    }
  } else {
    backendProcess = undefined;
    publishStatus(
      'starting',
      `Using the existing MCP backend and starting ${enabledConnections.length} configured ChatGPT tunnel${enabledConnections.length === 1 ? '' : 's'}…`,
      detectedTransport.tunnel.ready
        ? 'The existing backend and primary tunnel are already healthy; ForgeLink is reconciling every configured account.'
        : 'The existing backend is healthy; ForgeLink will start every configured tunnel automatically.',
    );
    if (existingCanonical) {
      tunnelRuntime.set(existingCanonical.id, {
        state: 'running',
        message: 'Connected securely',
        healthPort: HEALTH_PORT,
        tunnelIdMasked: maskConnection(existingCanonical).tunnelIdMasked,
        name: existingCanonical.name,
        ownership: 'detected',
        checkedAt: new Date().toISOString(),
      });
    }
  }

  const profileDir = dataPath('tunnel-client-data', 'profiles');
  await fsp.mkdir(profileDir, { recursive: true });
  const reservedPorts = new Set();
  const runtimeConnections = [];
  for (const connection of enabledConnections) {
    if (existingCanonical && connection.id === existingCanonical.id) continue;
    const healthPort = await chooseHealthPort(config.connections, connection.healthPort, reservedPorts);
    reservedPorts.add(healthPort);
    runtimeConnections.push({ connection, healthPort });
  }

  const startOne = async ({ connection, healthPort }) => {
    const existingHealth = await probeLoopback('/readyz', healthPort);
    if (existingHealth.healthy && existingHealth.body === 'ready') {
      tunnelRuntime.set(connection.id, {
        state: 'running',
        message: 'Connected securely',
        healthPort,
        tunnelIdMasked: maskConnection(connection).tunnelIdMasked,
        name: connection.name,
        ownership: 'detected',
        checkedAt: new Date().toISOString(),
      });
      return connection.id;
    }

    if (process.platform === 'win32' && existingHealth.status != null) {
      try {
        const checkCmd = `Get-NetTCPConnection -LocalPort ${healthPort} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
        const pidRes = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', checkCmd], { encoding: 'utf8', timeout: 3000 });
        const stalePid = parseInt(pidRes.stdout?.trim() || '', 10);
        if (stalePid && stalePid > 0 && stalePid !== process.pid) {
          spawnSync('taskkill.exe', ['/PID', String(stalePid), '/F', '/T'], { stdio: 'ignore', timeout: 3000 });
        }
      } catch {}
    }

    let secret = secrets.connections?.[connection.id]?.apiKey;
    let apiKey = '';

    // Backward-compatible recovery: the original ForgeLink setup encrypted
    // the same runtime key with Windows DPAPI. If this connection was imported
    // from that setup and the new safeStorage record is absent, recover it once
    // and immediately persist it in the new encrypted store.
    if (!secret) {
      const legacyKey = await readLegacyRuntimeKey();
      if (legacyKey && safeStorage.isEncryptionAvailable()) {
        secret = safeStorage.encryptString(legacyKey).toString('base64');
        secrets.connections[connection.id] = {
          ...(secrets.connections[connection.id] || {}),
          apiKey: secret,
        };
        await writeJson(dataPath('desktop-secrets.json'), secrets);
      }
    }

    if (!secret) throw new Error(`No encrypted runtime key is saved for ${connection.name}. Open Edit and save the runtime API key once.`);
    try { apiKey = safeStorage.decryptString(Buffer.from(secret, 'base64')); }
    catch { throw new Error(`The runtime key for ${connection.name} could not be decrypted on this computer.`); }

    const profileName = `forge-${safeConnectionLogName(connection.id)}`;
    const profilePath = path.join(profileDir, `${profileName}.yaml`);
    const runtimeConnection = { ...connection, healthPort };
    await fsp.writeFile(profilePath, buildTunnelProfile(runtimeConnection, healthPort), { mode: 0o600 });

    const tunnelEnv = { ...process.env, CONTROL_PLANE_API_KEY: apiKey };
    delete tunnelEnv.OPENAI_API_KEY;
    apiKey = undefined;
    tunnelRuntime.set(connection.id, {
      state: 'starting',
      message: 'Connecting…',
      healthPort,
      tunnelIdMasked: maskConnection(connection).tunnelIdMasked,
      name: connection.name,
    });

    const child = spawnLogged(client, ['run', '--profile', profileName, '--profile-dir', profileDir, '--log.level', 'warn'], tunnelEnv, `tunnel-${safeConnectionLogName(connection.id)}`);
    delete tunnelEnv.CONTROL_PLANE_API_KEY;
    tunnelProcesses.set(connection.id, child);
    child.once('exit', (code) => {
      if (tunnelProcesses.get(connection.id) === child) tunnelProcesses.delete(connection.id);
      const existing = tunnelRuntime.get(connection.id) || {};
      tunnelRuntime.set(connection.id, { ...existing, state: 'error', message: 'Tunnel stopped', detail: `Exit code ${code ?? 'unknown'}`, healthPort });
      if (runtimeIsActive()) {
        const statuses = [...tunnelRuntime.values()];
        const live = statuses.filter((status) => status.state === 'running').length;
        publishStatus(
          live ? 'degraded' : 'error',
          live ? `${live}/${enabledConnections.length} tunnel connections are live.` : 'All tunnel connections stopped.',
          statuses.map((status) => `${status.name}: ${status.state}`).join(' · '),
        );
      }
    });

    const tunnelReady = await waitFor(`http://127.0.0.1:${healthPort}/readyz`, (response, text) => response.ok && text.replaceAll('"', '').trim() === 'ready', 35000);
    if (!tunnelReady) {
      try { child.kill(); } catch {}
      tunnelProcesses.delete(connection.id);
      tunnelRuntime.set(connection.id, { ...tunnelRuntime.get(connection.id), state: 'error', message: 'Tunnel did not become ready', detail: 'Check the tunnel ID, runtime key, and OpenAI tunnel permissions.', healthPort });
      throw new Error(`${connection.name} tunnel did not become ready. Check its tunnel ID, runtime key, and OpenAI tunnel permissions.`);
    }
    tunnelRuntime.set(connection.id, { ...tunnelRuntime.get(connection.id), state: 'running', message: 'Connected securely', healthPort });
    return connection.id;
  };

  const results = await Promise.allSettled(runtimeConnections.map(startOne));
  const successful = results.filter((result) => result.status === 'fulfilled').length + (existingCanonical ? 1 : 0);
  const failed = results.filter((result) => result.status === 'rejected');
  const details = [
    backendRunsAsCurrentUser ? `Backend uses your signed-in ${platformName(process.platform)} account permissions.` : '',
    ...[...tunnelRuntime.values()].map((status) => `${status.name}: ${status.state}`),
  ].filter(Boolean).join(' · ');
  if (!successful) {
    await stopRuntime();
    const message = failed[0]?.reason?.message || 'No tunnel connection became ready.';
    throw new Error(message);
  }
  const state = successful === enabledConnections.length ? 'running' : 'degraded';
  publishStatus(state, `${successful}/${enabledConnections.length} ChatGPT tunnel connections live`, details);
  startAccessPromptPolling();
  return runtimeStatus;
}

async function stateForRenderer() {
  const { config, secrets } = await loadConnectionState();
  const runtimeConnections = Object.fromEntries(tunnelRuntime.entries());
  const sanitized = sanitizeConfiguration(config, runtimeConnections);
  sanitized.connections = sanitized.connections.map((connection) => ({
    ...connection,
    hasRuntimeKey: Boolean(secrets.connections?.[connection.id]?.apiKey),
  }));
  return {
    platform: process.platform,
    architecture: process.arch,
    version: app.getVersion(),
    packaged: app.isPackaged,
    configured: config.connections.length > 0,
    configuration: sanitized,
    connections: config.connections.map((connection) => ({
      ...connection,
      tunnelIdMasked: maskConnection(connection).tunnelIdMasked,
      runtime: runtimeConnections[connection.id] || { state: 'stopped' },
    })),
    runtime: { ...runtimeStatus, connections: runtimeConnections },
    tunnelBundled: fs.existsSync(tunnelBinaryPath()),
    launchAtLogin: config.launchAtLogin === true,
    launchAtLoginEffective: app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')
      ? app.getLoginItemSettings(loginItemQuery()).openAtLogin === true
      : false,
    automationMode: cachedAutomationMode,
    headlessBackground: cachedHeadlessBackground,
    isHeadless,
    maintenance: localSecurityMaintenanceState(),
  };
}


async function setLocalSafetyTrip(tripped, reason) {
  const wasRunning = runtimeIsActive();
  if (wasRunning) await stopRuntime();
  await writeJson(dataPath('safety-state.json'), {
    version: 1,
    tripped: tripped === true,
    trippedAt: tripped ? new Date().toISOString() : null,
    tripReason: tripped ? String(reason || 'Local owner emergency stop') : null,
  });
  const status = wasRunning ? await startRuntime() : runtimeStatus;
  return { ok: true, tripped: tripped === true, status };
}

function registerIpc() {
  ipcMain.handle('app:get-state', stateForRenderer);
  ipcMain.handle('folders:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose folders ChatGPT may use', properties: ['openDirectory', 'multiSelections', 'createDirectory'] });
    if (result.canceled) return [];
    const roots = [];
    for (const folder of result.filePaths) {
      const validated = await validateFolder(folder);
      if (isDriveRoot(validated)) {
        const approval = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Allow an entire drive?',
          message: `ChatGPT will be able to access files across ${validated}.`,
          detail: 'This includes personal files and potentially application or operating-system data. File tools can read, create, edit, move, and delete files under this drive, subject to your Windows account permissions. Use a project folder instead when possible.',
          buttons: ['Cancel', 'Allow this drive'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (approval.response !== 1) continue;
        approvedDriveRoots.add(process.platform === 'win32' ? validated.toLowerCase() : validated);
      }
      roots.push(validated);
    }
    return roots;
  });
  ipcMain.handle('config:save', async (_event, input) => {
    try {
      const { config } = await loadConnectionState();
      const first = config.connections[0];
      return {
        ok: true,
        ...(await saveConnection({
          id: input?.id || first?.id,
          name: input?.name || first?.name || 'Primary ChatGPT account',
          tunnelId: input?.tunnelId,
          apiKey: input?.apiKey,
          enabled: true,
        })),
      };
    } catch (error) { return { ok: false, error: publicError(error) }; }
  });
  ipcMain.handle('config:save-shared', async (_event, input) => {
    try { return { ok: true, ...(await saveSharedConfiguration(input)) }; }
    catch (error) { return { ok: false, error: publicError(error) }; }
  });
  ipcMain.handle('connections:save', async (_event, input) => {
    try { return { ok: true, ...(await saveConnection(input)) }; }
    catch (error) { return { ok: false, error: publicError(error) }; }
  });
  ipcMain.handle('connections:delete', async (_event, id) => {
    try { return { ok: true, ...(await deleteConnection(id)) }; }
    catch (error) { return { ok: false, error: publicError(error) }; }
  });
  ipcMain.handle('connections:set-enabled', async (_event, id, enabled) => {
    try { return { ok: true, ...(await setConnectionEnabled(id, enabled)) }; }
    catch (error) { return { ok: false, error: publicError(error) }; }
  });
  ipcMain.handle('runtime:start', async () => {
    try { return { ok: true, status: await startRuntime() }; }
    catch (error) { publishStatus('error', publicError(error)); return { ok: false, error: publicError(error), status: runtimeStatus }; }
  });
  ipcMain.handle('runtime:stop', async () => ({ ok: true, status: await stopRuntime() }));
  ipcMain.handle('safety:trip', async () => {
    try { return await setLocalSafetyTrip(true, 'Local owner emergency stop'); }
    catch (error) { return { ok: false, error: publicError(error) }; }
  });
  ipcMain.handle('safety:local-control-token', async () => ({ token: accessPromptToken || null }));
  ipcMain.handle('security:set-local-maintenance', async (_event, enabled) => {
    try {
      const next = enabled === true;
      if (next) {
        return {
          ok: false,
          error: 'Protected-source maintenance can only be enabled from the ForgeLink approval card in ChatGPT.',
          maintenance: localSecurityMaintenanceState(),
        };
      }
      return await setLocalSecurityMaintenance(false);
    } catch (error) {
      return { ok: false, error: publicError(error), maintenance: localSecurityMaintenanceState() };
    }
  });
  ipcMain.handle('safety:reset', async () => {
    const approval = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Reset ForgeLink safety trip?',
      message: 'Remote mutation is currently blocked by the safety circuit breaker.',
      detail: 'Reset only if you have reviewed the recent Safety Events and understand why the breaker tripped. UI automation will remain disabled after reset.',
      buttons: ['Cancel', 'Reset safety trip'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (approval.response !== 1) return { ok: false, cancelled: true };
    try { return await setLocalSafetyTrip(false); }
    catch (error) { return { ok: false, error: publicError(error) }; }
  });
  ipcMain.handle('links:dashboard', async () => shell.openExternal(`http://127.0.0.1:${DASHBOARD_PORT}/dashboard/`));
  ipcMain.handle('links:open', async (_event, name) => {
    if (!(name in links)) throw new Error('Unknown link.');
    return shell.openExternal(links[name]);
  });
  ipcMain.handle('app:launch-at-login', async (_event, enabled) => {
    try {
      const desired = enabled === true;
      const config = await loadConfiguration();
      await writeJson(dataPath('desktop-config.json'), { ...config, launchAtLogin: desired });
      const registration = applyLaunchAtLogin(desired);
      return { ok: true, ...registration };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  });
  ipcMain.handle('app:set-automation-mode', async (_event, mode) => {
    try {
      const normalized = normalizeAutomationMode(mode);
      const config = await loadConfiguration();
      const nextConfig = { ...config, automationMode: normalized };
      await writeJson(dataPath('desktop-config.json'), nextConfig);
      cachedAutomationMode = normalized;
      const access = await readJson(dataPath('access-config.json'), null);
      if (access) {
        await writeJson(dataPath('access-config.json'), { ...access, automationMode: normalized });
      }
      return { ok: true, automationMode: normalized };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  });
  ipcMain.handle('app:set-headless-background', async (_event, enabled) => {
    try {
      const desired = enabled === true;
      const config = await loadConfiguration();
      const nextConfig = { ...config, headlessBackground: desired };
      await writeJson(dataPath('desktop-config.json'), nextConfig);
      cachedHeadlessBackground = desired;
      return { ok: true, headlessBackground: desired };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  });
  ipcMain.handle('window:action', (_event, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (action === 'close') {
      if (cachedHeadlessBackground) {
        mainWindow.hide();
      } else {
        mainWindow.close();
      }
    }
    else return false;
    return true;
  });
}

function applyWindowsFrost(window) {
  if (process.platform !== 'win32' || !window || window.isDestroyed()) return;

  try {
    if (typeof window.setBackgroundMaterial === 'function') {
      window.setBackgroundMaterial('acrylic');
    }

    const handle = window.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : handle.readUInt32LE(0).toString();

    // Native Win32 fallback: force Desktop Acrylic behind the entire
    // transparent frameless Electron window. This prevents sharp desktop
    // transparency when Electron's higher-level backdrop is insufficient.
    const script = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ForgeLinkWindowEffects {
    [StructLayout(LayoutKind.Sequential)]
    private struct ACCENT_POLICY {
        public int AccentState;
        public int AccentFlags;
        public int GradientColor;
        public int AnimationId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WINDOWCOMPOSITIONATTRIBDATA {
        public int Attribute;
        public IntPtr Data;
        public int SizeOfData;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowCompositionAttribute(
        IntPtr hwnd,
        ref WINDOWCOMPOSITIONATTRIBDATA data
    );

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        IntPtr hwnd,
        int attribute,
        ref int value,
        int valueSize
    );

    public static void Apply(IntPtr hwnd) {
        int backdrop = 3; // DWMSBT_TRANSIENTWINDOW = Desktop Acrylic
        DwmSetWindowAttribute(hwnd, 38, ref backdrop, sizeof(int));

        int corners = 2; // DWMWCP_ROUND
        DwmSetWindowAttribute(hwnd, 33, ref corners, sizeof(int));

        var accent = new ACCENT_POLICY {
            AccentState = 4, // ACCENT_ENABLE_ACRYLICBLURBEHIND
            AccentFlags = 0x20 | 0x40 | 0x80 | 0x100,
            GradientColor = unchecked((int)0xA8000000),
            AnimationId = 0
        };

        int size = Marshal.SizeOf<ACCENT_POLICY>();
        IntPtr accentPtr = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(accent, accentPtr, false);
            var data = new WINDOWCOMPOSITIONATTRIBDATA {
                Attribute = 19, // WCA_ACCENT_POLICY
                Data = accentPtr,
                SizeOfData = size
            };
            SetWindowCompositionAttribute(hwnd, ref data);
        }
        finally {
            Marshal.FreeHGlobal(accentPtr);
        }
    }
}
'@

[ForgeLinkWindowEffects]::Apply([IntPtr]::new(${hwnd}))
`;

    const result = spawnSync(
      process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, encoding: 'utf8', timeout: 5000 }
    );

    if (result.error) console.warn('[ForgeLink] Native frost fallback failed:', result.error.message);
    if (result.status !== 0 && result.stderr) console.warn('[ForgeLink] Native frost fallback:', result.stderr.trim());
  } catch (error) {
    console.warn('[ForgeLink] Native frost setup failed:', error);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 900,
    minHeight: 650,
    frame: false,
    transparent: true,
    backgroundMaterial: process.platform === 'win32' ? 'acrylic' : undefined,
    show: false,
    backgroundColor: '#00000000',
    title: 'ForgeLink by Vidit Shah',
    webPreferences: {
      preload: path.join(moduleDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.removeMenu();
  if (process.platform === 'win32' && typeof mainWindow.setBackgroundMaterial === 'function') mainWindow.setBackgroundMaterial('acrylic');
  mainWindow.once('ready-to-show', () => {
    applyWindowsFrost(mainWindow);
    if (!isHeadless) {
      mainWindow.show();
      setTimeout(() => applyWindowsFrost(mainWindow), 120);
    }
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting && cachedHeadlessBackground) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:') && !url.startsWith('http://localhost:')) event.preventDefault();
  });
  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined' && MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(process.resourcesPath, 'dist', 'index.html'));
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) {
    mainWindow.show();
    applyWindowsFrost(mainWindow);
    setTimeout(() => applyWindowsFrost(mainWindow), 120);
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { showMainWindow(); });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.viditshah.forgelink');
    const config = await loadConfiguration();
    cachedHeadlessBackground = config?.headlessBackground === true;
    cachedAutomationMode = isHeadless ? 'headless' : normalizeAutomationMode(config?.automationMode);
    registerIpc();
    createWindow();
    applyLaunchAtLogin(config?.launchAtLogin === true);
    await clearStaleLocalSecurityMaintenanceOnStartup();
    startRuntimeHealthMonitor();
    if (config?.connections?.some((connection) => connection.enabled)) {
      startRuntime()
        .catch((error) => publishStatus('error', publicError(error)))
        .finally(() => { void reconcileRuntimeHealth({ force: true }); });
    }
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  stopRuntimeHealthMonitor();
  clearLocalSecurityMaintenanceTimer();
  localSecurityMaintenance = { enabled: false, expiresAt: null };
  try { fs.rmSync(localSecurityMaintenanceMarkerPath(), { force: true }); } catch {}
  if (canonicalRuntimeOwned && canonicalRuntimePid) {
    try { spawnSync('taskkill.exe', ['/PID', String(canonicalRuntimePid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
  canonicalRuntimeActive = false;
  canonicalRuntimePid = null;
  canonicalRuntimeOwned = false;
  for (const child of tunnelProcesses.values()) {
    try { child.kill(); } catch {}
  }
  if (backendProcess) {
    try { backendProcess.kill(); } catch {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !cachedHeadlessBackground) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else showMainWindow();
});
