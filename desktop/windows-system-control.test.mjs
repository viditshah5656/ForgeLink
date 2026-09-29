import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsSystemControl, normalizeSystemControlMode } from './windows-system-control.mjs';

test('normalizes Windows System Control modes safely', () => {
  assert.equal(normalizeSystemControlMode('off'), 'off');
  assert.equal(normalizeSystemControlMode('read'), 'read');
  assert.equal(normalizeSystemControlMode('full'), 'full');
  assert.equal(normalizeSystemControlMode('invalid'), 'off');
});

test('off mode exposes policy status without executing Windows commands', async () => {
  let executions = 0;
  const control = new WindowsSystemControl({ dataDir: '.', platform: 'win32', getMode: () => 'off', exec: async () => { executions += 1; return { stdout: '', stderr: '' }; } });
  const status = await control.status();
  assert.equal(status.mode, 'off');
  assert.equal(status.active, false);
  assert.equal(executions, 0);
  assert.throws(() => control.listSettings(), /System Control is Off/);
});

test('read mode lists settings but full mode is required to open one', async () => {
  const calls = [];
  const read = new WindowsSystemControl({ dataDir: '.', platform: 'win32', getMode: () => 'read', exec: async (...args) => { calls.push(args); return { stdout: '{}', stderr: '' }; } });
  assert.ok(read.listSettings('display').some((item) => item.id === 'display'));
  await assert.rejects(() => read.openSetting('display'), /Full System Control/);
  const full = new WindowsSystemControl({ dataDir: '.', platform: 'win32', getMode: () => 'full', guardUi: async () => {}, exec: async (...args) => { calls.push(args); return { stdout: '', stderr: '' }; } });
  const opened = await full.openSetting('display');
  assert.equal(opened.launched, true);
  assert.ok(calls.length >= 1);
});

test('Registry inspection blocks credential and authentication hives before execution', async () => {
  let executions = 0;
  const control = new WindowsSystemControl({ dataDir: '.', platform: 'win32', getMode: () => 'read', exec: async () => { executions += 1; return { stdout: '{}', stderr: '' }; } });
  await assert.rejects(() => control.registry({ action: 'get', path: 'HKLM\\SAM' }), /blocked/);
  await assert.rejects(() => control.registry({ action: 'get', path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa' }), /blocked/);
  assert.equal(executions, 0);
});

test('screenshot returns PNG bytes using a mocked capture backend', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forgelink-win-'));
  try {
    const control = new WindowsSystemControl({ dataDir: dir, platform: 'win32', getMode: () => 'read', exec: async () => ({ stdout: '{}', stderr: '' }) });
    control.runJson = async (_script, args) => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3K0AAAAASUVORK5CYII=', 'base64');
      await fsp.mkdir(path.dirname(args.output), { recursive: true });
      await fsp.writeFile(args.output, png);
      return { left: 0, top: 0, width: 1, height: 1, mode: args.mode, displayCount: 1 };
    };
    const result = await control.screenshot({ mode: 'desktop' });
    assert.equal(result.metadata.mimeType, 'image/png');
    assert.ok(result.buffer.length > 20);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('system-file surface is metadata/hash only and blocks credential stores', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forgelink-sys-'));
  try {
    const file = path.join(dir, 'sample.ini');
    await fsp.writeFile(file, 'hello windows');
    const control = new WindowsSystemControl({ dataDir: dir, platform: 'win32', getMode: () => 'read', exec: async () => ({ stdout: '{}', stderr: '' }) });
    control.systemRoots = () => [dir];
    const info = await control.systemFile({ action: 'info', path: file });
    const hash = await control.systemFile({ action: 'hash', path: file });
    assert.equal(info.path, file);
    assert.equal(hash.algorithm, 'sha256');
    await assert.rejects(() => control.systemFile({ action: 'read_text', path: file }), /metadata and hashes only/);
    const blocked = path.join(dir, 'System32', 'config', 'SAM');
    await assert.rejects(() => control.systemFile({ action: 'info', path: blocked }), /blocked/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('real-time desktop and browser observation require Read or Full mode', async () => {
  const off = new WindowsSystemControl({ dataDir: '.', platform: 'win32', getMode: () => 'off', exec: async () => ({ stdout: '{}', stderr: '' }) });
  await assert.rejects(() => off.desktopState(), /System Control is Off/);
  await assert.rejects(() => off.browserTabs(), /System Control is Off/);
  const read = new WindowsSystemControl({ dataDir: '.', platform: 'win32', getMode: () => 'read', exec: async () => ({ stdout: '{}', stderr: '' }) });
  read.runJson = async (_script, args) => ({ capturedAt: 'now', args });
  assert.equal((await read.desktopState({ limit: 7, query: 'Code' })).args.limit, 7);
  assert.equal((await read.browserTabs({ limit: 9, query: 'Docs' })).args.query, 'Docs');
});

test('installed app inventory is readable but app actions require Full mode', async () => {
  const read = new WindowsSystemControl({ dataDir: '.', platform: 'win32', getMode: () => 'read', exec: async () => ({ stdout: '{}', stderr: '' }) });
  read.runJson = async (_script, args) => ({ launchable: [], desktopInstalled: [], appPackages: [], args });
  assert.equal((await read.installedApps({ limit: 25 })).args.limit, 25);
  await assert.rejects(() => read.appControl({ action: 'launch', appId: 'sample' }), /Full System Control/);
});

test('app close requires exact PID identity and explicit close confirmation', async () => {
  let calls = 0;
  const full = new WindowsSystemControl({ dataDir: '.', platform: 'win32', getMode: () => 'full', guardUi: async () => {}, exec: async () => ({ stdout: '{}', stderr: '' }) });
  full.runJson = async (_script, args) => { calls += 1; return { action: args.action, pid: args.pid, processName: args.expected, closeRequested: true, stillRunning: true, forceKilled: false }; };
  await assert.rejects(() => full.appControl({ action: 'close', pid: 123, expectedProcessName: 'notepad' }), /confirmClose=true/);
  assert.equal(calls, 0);
  await assert.rejects(() => full.appControl({ action: 'close', pid: 123, confirmClose: true }), /expectedProcessName/);
  assert.equal(calls, 0);
  const closed = await full.appControl({ action: 'close', pid: 123, expectedProcessName: 'notepad', confirmClose: true });
  assert.equal(closed.forceKilled, false);
  assert.equal(calls, 1);
});

test('app launch accepts only an exact launchable identity and no arbitrary arguments', async () => {
  let received;
  const full = new WindowsSystemControl({ dataDir: '.', platform: 'win32', getMode: () => 'full', guardUi: async () => {}, exec: async () => ({ stdout: '{}', stderr: '' }) });
  full.runJson = async (_script, args) => { received = args; return { action: 'launch', name: 'Calculator', appId: args.appId || 'calc', requested: true }; };
  await assert.rejects(() => full.appControl({ action: 'launch' }), /exact appId or exact app name/);
  const result = await full.appControl({ action: 'launch', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' });
  assert.equal(result.requested, true);
  assert.deepEqual(received, { appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', name: '' });
});
