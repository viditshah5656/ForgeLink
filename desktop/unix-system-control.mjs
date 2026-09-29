import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPlatformDescriptor, platformName } from './platform-runtime.mjs';
import { normalizeSystemControlMode } from './shared.mjs';

const execFileAsync = promisify(execFile);
const MAX_TEXT = 24000;

function bounded(value, max = MAX_TEXT) {
  const text = String(value || '');
  return text.length <= max ? text : text.slice(0, max) + '\n…[truncated]';
}

function limitValue(value, fallback = 100, max = 300) {
  const parsed = Number(value ?? fallback);
  return Math.max(1, Math.min(Number.isFinite(parsed) ? Math.trunc(parsed) : fallback, max));
}

function parseDesktopEntry(text, file) {
  const lines = String(text || '').split(/\r?\n/);
  const values = new Map();
  let inDesktop = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '[Desktop Entry]') { inDesktop = true; continue; }
    if (line.startsWith('[') && line.endsWith(']')) { if (inDesktop) break; continue; }
    if (!inDesktop || !line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
  }
  if (values.get('Type') && values.get('Type') !== 'Application') return null;
  if (values.get('Hidden') === 'true' || values.get('NoDisplay') === 'true') return null;
  const name = values.get('Name');
  if (!name) return null;
  return { name, appId: file, desktopId: path.posix.basename(file, '.desktop') };
}

export class UnixSystemControl {
  constructor({
    platform = process.platform,
    getMode = () => 'off',
    exec = execFileAsync,
    audit = async () => {},
    guardUi = async () => {},
    existsSync = fs.existsSync,
    env = process.env,
    homeDirectory = os.homedir(),
    readFile = fsp.readFile,
    readdir = fsp.readdir,
    unlink = fsp.unlink,
    tempDirectory = os.tmpdir(),
  } = {}) {
    if (!['darwin', 'linux'].includes(platform)) throw new Error('UnixSystemControl supports macOS and Linux only.');
    this.platform = platform;
    this.getMode = getMode;
    this.exec = exec;
    this.audit = audit;
    this.guardUi = guardUi;
    this.existsSync = existsSync;
    this.env = env;
    this.homeDirectory = homeDirectory;
    this.readFile = readFile;
    this.readdir = readdir;
    this.unlink = unlink;
    this.tempDirectory = tempDirectory;
    this.descriptor = createPlatformDescriptor({ platform, env, homeDirectory, tempDirectory, existsSync });
  }

  mode() { return normalizeSystemControlMode(this.getMode()); }

  requireRead() {
    if (this.mode() === 'off') {
      throw new Error(`System Control is Off. Request ${platformName(this.platform)} Read or Full access first.`);
    }
  }

  requireFullUi() {
    if (this.mode() !== 'full') {
      throw new Error(`Full ${platformName(this.platform)} System Control is required for app or Settings actions.`);
    }
  }

  firstExisting(candidates) {
    return candidates.find((candidate) => {
      try { return this.existsSync(candidate); } catch { return false; }
    }) || null;
  }

  commands() {
    if (this.platform === 'darwin') {
      return {
        ps: this.firstExisting(['/bin/ps', '/usr/bin/ps']),
        services: this.firstExisting(['/bin/launchctl']),
        network: this.firstExisting(['/usr/sbin/scutil']),
        power: this.firstExisting(['/usr/bin/pmset']),
        open: this.firstExisting(['/usr/bin/open']),
        screenshot: this.firstExisting(['/usr/sbin/screencapture']),
      };
    }

    return {
      ps: this.firstExisting(['/bin/ps', '/usr/bin/ps']),
      services: this.firstExisting(['/bin/systemctl', '/usr/bin/systemctl']),
      network: this.firstExisting(['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip']),
      gio: this.firstExisting(['/usr/bin/gio', '/bin/gio']),
      gtkLaunch: this.firstExisting(['/usr/bin/gtk-launch', '/bin/gtk-launch']),
      gnomeSettings: this.firstExisting(['/usr/bin/gnome-control-center', '/bin/gnome-control-center']),
      kdeSettings: this.firstExisting(['/usr/bin/systemsettings', '/usr/bin/systemsettings5', '/usr/bin/systemsettings6']),
      grim: this.firstExisting(['/usr/bin/grim', '/bin/grim']),
      gnomeScreenshot: this.firstExisting(['/usr/bin/gnome-screenshot', '/bin/gnome-screenshot']),
    };
  }

  capabilities() {
    const command = this.commands();
    return {
      status: true,
      processes: Boolean(command.ps),
      services: Boolean(command.services),
      network: Boolean(command.network),
      power: this.platform === 'darwin' ? Boolean(command.power) : true,
      installedApps: true,
      appLaunch: this.platform === 'darwin' ? Boolean(command.open) : Boolean(command.gio || command.gtkLaunch),
      settings: this.platform === 'darwin' ? Boolean(command.open) : Boolean(command.gnomeSettings || command.kdeSettings),
      screenshot: this.platform === 'darwin' ? Boolean(command.screenshot) : Boolean(command.grim || command.gnomeScreenshot),
      desktopState: false,
      browserTabs: false,
      forceKill: false,
      privilegeEscalation: false,
    };
  }

  async run(file, args = [], timeout = 15000) {
    if (!file) throw new Error(`Required native ${platformName(this.platform)} command is unavailable.`);
    const result = await this.exec(file, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: this.env,
    });
    return { stdout: bounded(result?.stdout), stderr: bounded(result?.stderr) };
  }

  async status() {
    return {
      capturedAt: new Date().toISOString(),
      platform: this.descriptor,
      mode: this.mode(),
      capabilities: this.capabilities(),
      safety: {
        explicitOwnerModeRequired: true,
        noImplicitPrivilegeEscalation: true,
        osPrivacyAndAclRemainEnforced: true,
      },
    };
  }

  async processes(input = {}) {
    this.requireRead();
    const limit = limitValue(input.limit, 100, 300);
    const query = String(input.query || '').trim().toLowerCase();
    const { stdout } = await this.run(this.commands().ps, ['-axo', 'pid=,ppid=,comm=,%cpu=,%mem=']);
    const rows = stdout.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)$/);
        return match ? {
          pid: Number(match[1]),
          parentPid: Number(match[2]),
          executable: match[3],
          cpuPercent: Number(match[4]),
          memoryPercent: Number(match[5]),
        } : null;
      })
      .filter(Boolean)
      .filter((item) => !query || item.executable.toLowerCase().includes(query))
      .slice(0, limit);
    return { capturedAt: new Date().toISOString(), platform: this.descriptor.id, processes: rows, limit };
  }

  async services(input = {}) {
    this.requireRead();
    const limit = limitValue(input.limit, 100, 300);
    const query = String(input.query || input.name || '').trim().toLowerCase();
    const command = this.commands().services;
    if (!command) {
      return {
        capturedAt: new Date().toISOString(),
        platform: this.descriptor.id,
        supported: false,
        reason: 'No supported service manager was detected.',
      };
    }

    if (this.platform === 'darwin') {
      const { stdout } = await this.run(command, ['list']);
      const services = stdout.split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\s+/);
          if (parts.length < 3) return null;
          return {
            pid: parts[0] === '-' ? null : Number(parts[0]),
            lastExitStatus: Number(parts[1]),
            label: parts.slice(2).join(' '),
          };
        })
        .filter(Boolean)
        .filter((item) => !query || item.label.toLowerCase().includes(query))
        .slice(0, limit);
      return { capturedAt: new Date().toISOString(), platform: 'macos', manager: 'launchd', services, limit };
    }

    const { stdout } = await this.run(command, ['list-units', '--type=service', '--all', '--no-pager', '--no-legend']);
    const services = stdout.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        if (parts.length < 4) return null;
        return {
          name: parts[0],
          load: parts[1],
          active: parts[2],
          sub: parts[3],
          description: parts.slice(4).join(' '),
        };
      })
      .filter(Boolean)
      .filter((item) => !query || item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query))
      .slice(0, limit);
    return { capturedAt: new Date().toISOString(), platform: 'linux', manager: 'systemd', services, limit };
  }

  async network() {
    this.requireRead();
    const command = this.commands().network;
    if (!command) {
      return {
        capturedAt: new Date().toISOString(),
        platform: this.descriptor.id,
        supported: false,
        reason: 'No supported native network observer was detected.',
      };
    }

    if (this.platform === 'darwin') {
      const { stdout, stderr } = await this.run(command, ['--nwi']);
      return { capturedAt: new Date().toISOString(), platform: 'macos', source: 'scutil --nwi', summary: stdout, stderr };
    }

    const addresses = await this.run(command, ['-brief', 'address']);
    const routes = await this.run(command, ['route', 'show', 'default']);
    return {
      capturedAt: new Date().toISOString(),
      platform: 'linux',
      addresses: addresses.stdout,
      defaultRoutes: routes.stdout,
    };
  }

  async power() {
    this.requireRead();
    if (this.platform === 'darwin') {
      const command = this.commands().power;
      if (!command) return { capturedAt: new Date().toISOString(), platform: 'macos', supported: false };
      const { stdout } = await this.run(command, ['-g', 'batt']);
      return { capturedAt: new Date().toISOString(), platform: 'macos', source: 'pmset', battery: stdout };
    }

    const root = '/sys/class/power_supply';
    let entries = [];
    try { entries = await this.readdir(root, { withFileTypes: true }); } catch {}
    const supplies = [];
    for (const entry of entries.slice(0, 16)) {
      if (!entry.isDirectory()) continue;
      const base = path.posix.join(root, entry.name);
      const read = async (name) => {
        try { return String(await this.readFile(path.posix.join(base, name), 'utf8')).trim(); } catch { return null; }
      };
      const type = await read('type');
      const status = await read('status');
      const capacity = await read('capacity');
      supplies.push({
        name: entry.name,
        type,
        status,
        capacityPercent: capacity == null ? null : Number(capacity),
      });
    }
    return { capturedAt: new Date().toISOString(), platform: 'linux', supplies };
  }

  async installedApps(input = {}) {
    this.requireRead();
    const limit = limitValue(input.limit, 100, 300);
    const query = String(input.query || '').trim().toLowerCase();
    const apps = [];

    if (this.platform === 'darwin') {
      for (const root of this.descriptor.applicationRoots) {
        let entries = [];
        try { entries = await this.readdir(root, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
          const name = entry.name.slice(0, -4);
          if (query && !name.toLowerCase().includes(query)) continue;
          apps.push({ name, appId: path.posix.join(root, entry.name), source: root });
          if (apps.length >= limit) break;
        }
        if (apps.length >= limit) break;
      }
    } else {
      for (const root of this.descriptor.applicationRoots.filter((item) => item?.endsWith('applications'))) {
        let entries = [];
        try { entries = await this.readdir(root, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.desktop')) continue;
          const file = path.posix.join(root, entry.name);
          let parsed = null;
          try { parsed = parseDesktopEntry(await this.readFile(file, 'utf8'), file); } catch {}
          if (!parsed || (query && !parsed.name.toLowerCase().includes(query))) continue;
          apps.push({ ...parsed, source: root });
          if (apps.length >= limit) break;
        }
        if (apps.length >= limit) break;
      }
    }

    return { capturedAt: new Date().toISOString(), platform: this.descriptor.id, apps, limit };
  }

  async appControl(input = {}) {
    this.requireFullUi();
    if (input.action !== 'launch') {
      throw new Error('macOS/Linux app control currently permits exact app launch only; focus/close are not exposed without a stable native window identity.');
    }
    const appId = String(input.appId || '').trim();
    if (!appId) throw new Error('launch requires an exact appId from system_installed_apps.');

    const inventory = await this.installedApps({ limit: 300 });
    const match = inventory.apps.find((app) => app.appId === appId);
    if (!match) throw new Error('The requested appId is not present in the current bounded app inventory.');

    await this.guardUi({ action: 'app_launch', target: appId });
    if (this.platform === 'darwin') {
      await this.run(this.commands().open, [appId]);
    } else {
      const commands = this.commands();
      if (commands.gio) await this.run(commands.gio, ['launch', appId]);
      else if (commands.gtkLaunch) await this.run(commands.gtkLaunch, [match.desktopId]);
      else throw new Error('No supported Linux desktop application launcher was detected.');
    }

    await this.audit('system.app.launch', { platform: this.descriptor.id, appId, name: match.name });
    return { action: 'launch', requested: true, platform: this.descriptor.id, appId, name: match.name };
  }

  settingsTable() {
    if (this.platform === 'darwin') {
      return [
        { id: 'general', name: 'General', target: 'x-apple.systempreferences:com.apple.SystemPreferences' },
        { id: 'network', name: 'Network', target: 'x-apple.systempreferences:com.apple.Network-Settings.extension' },
        { id: 'privacy', name: 'Privacy & Security', target: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension' },
        { id: 'display', name: 'Displays', target: 'x-apple.systempreferences:com.apple.Displays-Settings.extension' },
        { id: 'sound', name: 'Sound', target: 'x-apple.systempreferences:com.apple.Sound-Settings.extension' },
        { id: 'battery', name: 'Battery', target: 'x-apple.systempreferences:com.apple.Battery-Settings.extension' },
        { id: 'bluetooth', name: 'Bluetooth', target: 'x-apple.systempreferences:com.apple.BluetoothSettings' },
      ];
    }

    const commands = this.commands();
    const items = [];
    if (commands.gnomeSettings) {
      for (const [id, name, section] of [
        ['gnome-main', 'Settings', null],
        ['gnome-network', 'Network', 'network'],
        ['gnome-wifi', 'Wi-Fi', 'wifi'],
        ['gnome-bluetooth', 'Bluetooth', 'bluetooth'],
        ['gnome-display', 'Displays', 'display'],
        ['gnome-sound', 'Sound', 'sound'],
        ['gnome-power', 'Power', 'power'],
        ['gnome-privacy', 'Privacy', 'privacy'],
      ]) {
        items.push({ id, name, file: commands.gnomeSettings, args: section ? [section] : [] });
      }
    }
    if (commands.kdeSettings) {
      items.push({ id: 'kde-main', name: 'System Settings', file: commands.kdeSettings, args: [] });
    }
    return items;
  }

  listSettings(query = '') {
    this.requireRead();
    const q = String(query || '').trim().toLowerCase();
    return this.settingsTable()
      .filter((item) => !q || item.id.includes(q) || item.name.toLowerCase().includes(q))
      .map(({ file, args, target, ...safe }) => safe);
  }

  async openSetting(id) {
    this.requireFullUi();
    const requested = String(id || '').trim().toLowerCase();
    const match = this.settingsTable().find((item) => item.id === requested);
    if (!match) throw new Error(`Unknown or unavailable ${platformName(this.platform)} Settings destination.`);

    await this.guardUi({ action: 'settings_open', target: match.id });
    if (this.platform === 'darwin') await this.run(this.commands().open, [match.target]);
    else await this.run(match.file, match.args);

    await this.audit('system.settings.open', { platform: this.descriptor.id, id: match.id });
    return { opened: true, id: match.id, name: match.name, platform: this.descriptor.id };
  }

  async screenshot(input = {}) {
    this.requireRead();
    const commands = this.commands();
    const mode = input.mode || 'desktop';
    const target = path.join(this.tempDirectory, `forgelink-shot-${process.pid}-${Date.now()}.png`);

    if (this.platform === 'darwin') {
      const args = ['-x'];
      if (mode === 'display') args.push(`-D${Number(input.display || 0) + 1}`);
      if (mode === 'region') {
        if (!input.width || !input.height) throw new Error('Region screenshots require width and height.');
        args.push('-R', `${Number(input.x || 0)},${Number(input.y || 0)},${Number(input.width)},${Number(input.height)}`);
      }
      args.push(target);
      try {
        await this.run(commands.screenshot, args, 20000);
        return {
          buffer: await this.readFile(target),
          metadata: { platform: 'macos', mode, display: input.display ?? null },
        };
      } finally {
        await this.unlink(target).catch(() => {});
      }
    }

    if (mode !== 'desktop') {
      throw new Error('Linux screenshot capture currently supports desktop mode only because display/region semantics differ between Wayland and X11.');
    }
    try {
      if (commands.grim) await this.run(commands.grim, [target], 20000);
      else if (commands.gnomeScreenshot) await this.run(commands.gnomeScreenshot, ['-f', target], 20000);
      else throw new Error('No supported Linux screenshot backend (grim or gnome-screenshot) is available.');
      return {
        buffer: await this.readFile(target),
        metadata: {
          platform: 'linux',
          mode: 'desktop',
          sessionType: this.env.XDG_SESSION_TYPE || null,
        },
      };
    } finally {
      await this.unlink(target).catch(() => {});
    }
  }

  async overview() {
    this.requireRead();
    const settled = await Promise.allSettled([
      this.status(),
      this.processes({ limit: 40 }),
      this.services({ limit: 40 }),
      this.network(),
      this.power(),
      this.installedApps({ limit: 40 }),
    ]);
    const names = ['status', 'processes', 'services', 'network', 'power', 'installedApps'];
    const result = { capturedAt: new Date().toISOString(), platform: this.descriptor.id };
    settled.forEach((item, index) => {
      result[names[index]] = item.status === 'fulfilled'
        ? item.value
        : { error: String(item.reason?.message || item.reason) };
    });
    return result;
  }
}
