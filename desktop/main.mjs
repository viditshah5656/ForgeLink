import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, utilityProcess } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isValidTunnelId, normalizeTerminalMode, redactSensitive } from './shared.mjs';

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
let tunnelProcess;
let runtimeStatus = { state: 'stopped', message: 'Ready to start', updatedAt: Date.now() };

if (squirrelStartup) app.quit();

function dataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function publicError(error) {
  return redactSensitive(error);
}

function publishStatus(state, message, detail = '') {
  runtimeStatus = { state, message, detail, updatedAt: Date.now() };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:status', runtimeStatus);
}

async function readJson(filename, fallback = null) {
  try { return JSON.parse(await fsp.readFile(filename, 'utf8')); } catch { return fallback; }
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
  if (path.parse(folder).root.toLowerCase() === folder.toLowerCase()) throw new Error('For safety, choose a folder instead of an entire drive.');
  return folder;
}

async function loadConfiguration() {
  return readJson(dataPath('desktop-config.json'), null);
}

async function saveConfiguration(input) {
  const tunnelId = String(input?.tunnelId || '').trim();
  const apiKey = String(input?.apiKey || '');
  if (!isValidTunnelId(tunnelId)) throw new Error('The tunnel ID must look like tunnel_ followed by 32 lowercase letters or numbers.');
  const previousSecrets = await readJson(dataPath('desktop-secrets.json'), null);
  if (!apiKey && !previousSecrets?.apiKey) throw new Error('Paste the runtime API key once. It will be encrypted on this computer.');
  if (apiKey && (!apiKey.startsWith('sk-') || apiKey.length < 20)) throw new Error('That runtime API key does not look valid.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure system storage is not available. Sign in to your computer and try again.');

  const roots = [];
  for (const root of Array.isArray(input?.roots) ? input.roots : []) roots.push(await validateFolder(root));
  const uniqueRoots = [...new Map(roots.map((root) => [process.platform === 'win32' ? root.toLowerCase() : root, root])).values()];
  if (!uniqueRoots.length) throw new Error('Choose at least one folder for ChatGPT.');
  const terminalMode = normalizeTerminalMode(input?.terminalMode);

  const secretRecord = {
    version: 1,
    apiKey: apiKey ? safeStorage.encryptString(apiKey).toString('base64') : previousSecrets.apiKey,
  };
  const config = { version: 1, tunnelId, allowedRoots: uniqueRoots, terminalMode, launchAtLogin: input?.launchAtLogin === true };
  const access = { allowedRoots: uniqueRoots, terminalMode };
  const password = crypto.randomBytes(32).toString('base64url');
  const env = `# Created by Local Files for ChatGPT.\nALLOWED_ROOT=${uniqueRoots[0]}\nPORT=${PORT}\nDASHBOARD_PORT=${DASHBOARD_PORT}\n${['OAUTH_LOGIN_PASSWORD', password].join('=')}\n`;
  const profileDir = dataPath('tunnel-client-data', 'profiles');
  const profile = `config_version: 1\ncontrol_plane:\n  base_url: "https://api.openai.com"\n  tunnel_id: "${tunnelId}"\n  api_key: "env:CONTROL_PLANE_API_KEY"\nhealth:\n  listen_addr: "127.0.0.1:${HEALTH_PORT}"\nadmin_ui:\n  open_browser: false\nlog:\n  level: info\n  format: json\nmcp:\n  server_urls:\n    - channel: main\n      url: "http://127.0.0.1:${PORT}/mcp"\n`;

  await fsp.mkdir(profileDir, { recursive: true });
  await Promise.all([
    writeJson(dataPath('desktop-secrets.json'), secretRecord),
    writeJson(dataPath('desktop-config.json'), config),
    writeJson(dataPath('access-config.json'), access),
    fsp.writeFile(dataPath('.env'), env, { mode: 0o600 }),
    fsp.writeFile(path.join(profileDir, 'local-files.yaml'), profile, { mode: 0o600 }),
  ]);
  app.setLoginItemSettings({ openAtLogin: config.launchAtLogin });
  return sanitizeConfiguration(config);
}

function sanitizeConfiguration(config) {
  if (!config) return null;
  return {
    ...config,
    tunnelIdMasked: `${config.tunnelId.slice(0, 12)}…${config.tunnelId.slice(-4)}`,
    tunnelId: config.tunnelId,
  };
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

function spawnLogged(file, args, env, logName) {
  const logs = dataPath('tunnel-client-data');
  fs.mkdirSync(logs, { recursive: true });
  const output = fs.openSync(path.join(logs, `${logName}.log`), 'a');
  const errors = fs.openSync(path.join(logs, `${logName}.err.log`), 'a');
  const child = spawn(file, args, { cwd: app.getAppPath(), env, windowsHide: true, stdio: ['ignore', output, errors] });
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
    serviceName: 'Local Files MCP backend',
  });
  child.stdout?.pipe(output);
  child.stderr?.pipe(errors);
  child.once('exit', () => { output.end(); errors.end(); });
  return child;
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

async function stopRuntime() {
  for (const child of [tunnelProcess, backendProcess]) {
    if (child) {
      try { child.kill(); } catch {}
    }
  }
  tunnelProcess = undefined;
  backendProcess = undefined;
  publishStatus('stopped', 'Service stopped');
  return runtimeStatus;
}

async function startRuntime() {
  if (runtimeStatus.state === 'running') return runtimeStatus;
  if (runtimeStatus.state === 'starting') throw new Error('The service is already starting.');
  const config = await loadConfiguration();
  if (!config) throw new Error('Finish the setup first.');
  const secrets = await readJson(dataPath('desktop-secrets.json'), null);
  if (!secrets?.apiKey || !safeStorage.isEncryptionAvailable()) throw new Error('The encrypted runtime key is unavailable. Save the connection again.');
  const client = tunnelBinaryPath();
  if (!fs.existsSync(client)) throw new Error('The secure tunnel component is missing. Reinstall the application.');

  await stopRuntime();
  publishStatus('starting', 'Starting the private local service…');
  const commonEnv = { ...process.env, MCP_DATA_DIR: app.getPath('userData'), MCP_ASSET_DIR: app.isPackaged ? process.resourcesPath : app.getAppPath(), PORT: String(PORT), DASHBOARD_PORT: String(DASHBOARD_PORT), NO_AUTH: '1', PUBLIC_URL: `http://localhost:${PORT}` };
  backendProcess = spawnBackend(commonEnv);
  backendProcess.once('exit', (code) => {
    if (runtimeStatus.state === 'running') publishStatus('error', 'The local service stopped unexpectedly.', `Exit code ${code ?? 'unknown'}`);
  });
  const backendReady = await waitFor(`http://127.0.0.1:${PORT}/`, (response) => response.ok, 15000);
  if (!backendReady) {
    await stopRuntime();
    throw new Error('The local MCP server could not start. Check the diagnostic logs from the app.');
  }

  publishStatus('starting', 'Connecting the encrypted tunnel…');
  let apiKey;
  try { apiKey = safeStorage.decryptString(Buffer.from(secrets.apiKey, 'base64')); }
  catch { await stopRuntime(); throw new Error('The runtime key could not be decrypted for this computer account.'); }
  const tunnelEnv = { ...process.env, CONTROL_PLANE_API_KEY: apiKey };
  apiKey = undefined;
  tunnelProcess = spawnLogged(client, ['run', '--profile', 'local-files', '--profile-dir', dataPath('tunnel-client-data', 'profiles'), '--log.level', 'warn'], tunnelEnv, 'tunnel');
  delete tunnelEnv.CONTROL_PLANE_API_KEY;
  tunnelProcess.once('exit', (code) => {
    if (runtimeStatus.state === 'running' || runtimeStatus.state === 'starting') publishStatus('error', 'The secure tunnel stopped.', `Exit code ${code ?? 'unknown'}`);
  });
  const tunnelReady = await waitFor(`http://127.0.0.1:${HEALTH_PORT}/readyz`, (response, text) => response.ok && text.replaceAll('"', '').trim() === 'ready', 35000);
  if (!tunnelReady) {
    await stopRuntime();
    throw new Error('The secure tunnel could not connect. Check the tunnel ID, runtime key, and internet connection.');
  }
  publishStatus('running', 'Connected securely', 'ChatGPT can now reach the folders you allowed.');
  return runtimeStatus;
}

async function stateForRenderer() {
  const config = await loadConfiguration();
  return {
    platform: process.platform,
    architecture: process.arch,
    version: app.getVersion(),
    packaged: app.isPackaged,
    configured: Boolean(config),
    configuration: sanitizeConfiguration(config),
    runtime: runtimeStatus,
    tunnelBundled: fs.existsSync(tunnelBinaryPath()),
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
  };
}

function registerIpc() {
  ipcMain.handle('app:get-state', stateForRenderer);
  ipcMain.handle('folders:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose folders ChatGPT may use', properties: ['openDirectory', 'multiSelections', 'createDirectory'] });
    if (result.canceled) return [];
    const roots = [];
    for (const folder of result.filePaths) roots.push(await validateFolder(folder));
    return roots;
  });
  ipcMain.handle('config:save', async (_event, input) => {
    try { return { ok: true, configuration: await saveConfiguration(input) }; }
    catch (error) { return { ok: false, error: publicError(error) }; }
  });
  ipcMain.handle('runtime:start', async () => {
    try { return { ok: true, status: await startRuntime() }; }
    catch (error) { publishStatus('error', publicError(error)); return { ok: false, error: publicError(error) }; }
  });
  ipcMain.handle('runtime:stop', async () => ({ ok: true, status: await stopRuntime() }));
  ipcMain.handle('links:dashboard', async () => shell.openExternal(`http://127.0.0.1:${DASHBOARD_PORT}/dashboard/`));
  ipcMain.handle('links:open', async (_event, name) => {
    if (!(name in links)) throw new Error('Unknown link.');
    return shell.openExternal(links[name]);
  });
  ipcMain.handle('app:launch-at-login', async (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: enabled === true });
    const config = await loadConfiguration();
    if (config) await writeJson(dataPath('desktop-config.json'), { ...config, launchAtLogin: enabled === true });
    return app.getLoginItemSettings().openAtLogin;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 900,
    minHeight: 650,
    show: false,
    backgroundColor: '#f4f5f1',
    title: 'Local Files for ChatGPT',
    webPreferences: {
      preload: path.join(moduleDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => mainWindow.show());
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

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.squirrel.LocalFilesForChatGPT.LocalFilesForChatGPT');
    registerIpc();
    createWindow();
    const config = await loadConfiguration();
    if (config) startRuntime().catch((error) => publishStatus('error', publicError(error)));
  });
}

app.on('before-quit', () => {
  for (const child of [tunnelProcess, backendProcess]) {
    if (child) {
      try { child.kill(); } catch {}
    }
  }
});

app.on('window-all-closed', () => app.quit());
