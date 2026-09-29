import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLATFORM_NAMES = Object.freeze({
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
});

const PLATFORM_IDS = Object.freeze({
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux',
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizedPlatform(platform = process.platform) {
  if (!Object.hasOwn(PLATFORM_IDS, platform)) {
    throw new Error(`Unsupported ForgeLink host platform: ${platform}`);
  }
  return platform;
}

function executableExists(candidate, existsSync) {
  if (!candidate) return false;
  try { return existsSync(candidate); } catch { return false; }
}

function unixShellId(file) {
  const name = path.posix.basename(String(file || '')).toLowerCase();
  return ['zsh', 'bash', 'fish', 'sh'].includes(name) ? name : null;
}

export function platformId(platform = process.platform) {
  return PLATFORM_IDS[normalizedPlatform(platform)];
}

export function platformName(platform = process.platform) {
  return PLATFORM_NAMES[normalizedPlatform(platform)];
}

export function pathKey(value, { platform = process.platform, pathApi } = {}) {
  const selected = normalizedPlatform(platform);
  const api = pathApi || (selected === 'win32' ? path.win32 : path.posix);
  const normalized = api.normalize(String(value || ''));
  return selected === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isFilesystemRoot(value, { platform = process.platform, pathApi } = {}) {
  const selected = normalizedPlatform(platform);
  const api = pathApi || (selected === 'win32' ? path.win32 : path.posix);
  const normalized = api.resolve(String(value || ''));
  return pathKey(api.parse(normalized).root, { platform: selected, pathApi: api }) === pathKey(normalized, { platform: selected, pathApi: api });
}

export function terminalShellDefinitions({
  platform = process.platform,
  env = process.env,
  cwd = process.cwd(),
  existsSync = fs.existsSync,
} = {}) {
  const selected = normalizedPlatform(platform);
  if (selected === 'win32') {
    const systemRoot = env.SystemRoot || 'C:\\Windows';
    const system32 = path.win32.join(systemRoot, 'System32');
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const candidates = [
      { id: 'pwsh', family: 'powershell', file: path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'), args: ['-NoLogo', '-NoProfile'] },
      { id: 'powershell', family: 'powershell', file: path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile'] },
      { id: 'cmd', family: 'cmd', file: path.win32.join(system32, 'cmd.exe'), args: ['/Q'] },
      { id: 'git-bash', family: 'bash', file: path.win32.join(programFiles, 'Git', 'bin', 'bash.exe'), args: ['--noprofile', '--norc', '-i'] },
      { id: 'git-bash', family: 'bash', file: path.win32.join(programFilesX86, 'Git', 'bin', 'bash.exe'), args: ['--noprofile', '--norc', '-i'] },
      { id: 'wsl', family: 'wsl', file: path.win32.join(system32, 'wsl.exe'), args: ['--cd', cwd] },
    ];
    const seen = new Set();
    return candidates.filter((candidate) => {
      if (seen.has(candidate.id) || !executableExists(candidate.file, existsSync)) return false;
      seen.add(candidate.id);
      return true;
    }).map((candidate, index) => ({ ...candidate, default: index === 0 }));
  }

  const preferred = unixShellId(env.SHELL) ? env.SHELL : null;
  const candidatePaths = selected === 'darwin'
    ? unique([preferred, '/bin/zsh', '/bin/bash', '/bin/sh', '/opt/homebrew/bin/fish', '/usr/local/bin/fish'])
    : unique([preferred, '/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/usr/bin/fish', '/bin/fish', '/bin/sh', '/usr/bin/sh']);
  const shells = [];
  const seen = new Set();
  for (const file of candidatePaths) {
    const id = unixShellId(file);
    if (!id || seen.has(id) || !executableExists(file, existsSync)) continue;
    seen.add(id);
    shells.push({ id, family: id, file, args: [], default: shells.length === 0 });
  }
  return shells;
}

export function availableNativeShells(options = {}) {
  return terminalShellDefinitions(options).map((shell) => shell.id);
}

export function resolveTerminalShell(shell, options = {}) {
  const definitions = terminalShellDefinitions(options);
  const selected = definitions.find((candidate) => candidate.id === shell);
  if (!selected) {
    const platform = options.platform || process.platform;
    const available = definitions.map((candidate) => candidate.id);
    throw new Error(`Shell ${shell} is unavailable on ${platformName(platform)}. Available shells: ${available.join(', ') || 'none'}`);
  }
  return { file: selected.file, args: [...selected.args], family: selected.family };
}

export function defaultNativeShell(options = {}) {
  return terminalShellDefinitions(options).find((shell) => shell.default) || null;
}

function descriptorRoots(selected, env, home, tmp) {
  if (selected === 'win32') {
    const drive = env.SystemDrive || path.win32.parse(home || env.USERPROFILE || 'C:\\').root || 'C:\\';
    return unique([
      drive,
      env.USERPROFILE || home,
      env.SystemRoot,
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.ProgramData,
      env.APPDATA,
      env.LOCALAPPDATA,
      tmp,
    ]);
  }
  if (selected === 'darwin') {
    return unique(['/', home, '/Applications', home && path.posix.join(home, 'Applications'), '/Library', home && path.posix.join(home, 'Library'), '/System', '/usr', '/opt', '/private', tmp]);
  }
  return unique(['/', home, '/etc', '/var', '/usr', '/opt', '/srv', '/root', '/proc', '/sys', '/run', env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, tmp]);
}

export function createPlatformDescriptor({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  homeDirectory = os.homedir(),
  tempDirectory = os.tmpdir(),
  existsSync = fs.existsSync,
} = {}) {
  const selected = normalizedPlatform(platform);
  const shells = terminalShellDefinitions({ platform: selected, env, cwd: homeDirectory || process.cwd(), existsSync });
  const id = platformId(selected);
  const roots = descriptorRoots(selected, env, homeDirectory, tempDirectory);
  const common = {
    id,
    nodePlatform: selected,
    name: platformName(selected),
    arch,
    homeDirectory,
    tempDirectory,
    pathSeparator: selected === 'win32' ? '\\' : '/',
    executableSuffix: selected === 'win32' ? '.exe' : '',
    filesystemCaseSensitivity: selected === 'win32' ? 'insensitive' : selected === 'linux' ? 'sensitive' : 'volume-dependent',
    roots,
    shells,
    defaultShell: shells.find((shell) => shell.default)?.id || null,
    nativeOpener: selected === 'win32' ? 'explorer.exe' : selected === 'darwin' ? 'open' : 'xdg-open',
    permissionModel: selected === 'win32' ? 'acl+uac' : selected === 'darwin' ? 'posix+tcc+sip' : 'posix+acl+lsm',
    noImplicitPrivilegeEscalation: true,
  };
  if (selected === 'win32') {
    return {
      ...common,
      packageManagers: ['winget', 'choco', 'scoop'],
      serviceManagers: ['Service Control Manager'],
      privacyBoundaries: ['UAC', 'Windows ACLs', 'credential stores'],
      protectedRoots: unique([env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData]),
      applicationRoots: unique([env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]),
    };
  }
  if (selected === 'darwin') {
    return {
      ...common,
      packageManagers: ['brew', 'port'],
      serviceManagers: ['launchd'],
      privacyBoundaries: ['TCC', 'SIP', 'POSIX permissions', 'Full Disk Access', 'Screen Recording', 'Accessibility'],
      protectedRoots: ['/System', '/usr', '/bin', '/sbin', '/private/var/db'],
      applicationRoots: unique(['/Applications', homeDirectory && path.posix.join(homeDirectory, 'Applications')]),
      privacyFolders: unique([homeDirectory && path.posix.join(homeDirectory, 'Desktop'), homeDirectory && path.posix.join(homeDirectory, 'Documents'), homeDirectory && path.posix.join(homeDirectory, 'Downloads'), homeDirectory && path.posix.join(homeDirectory, 'Library')]),
    };
  }
  return {
    ...common,
    packageManagers: ['apt', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'flatpak', 'snap'],
    serviceManagers: ['systemd', 'OpenRC', 'SysV init'],
    privacyBoundaries: ['POSIX permissions', 'ACLs', 'SELinux', 'AppArmor', 'polkit'],
    protectedRoots: ['/etc', '/root', '/boot', '/proc', '/sys'],
    applicationRoots: unique(['/usr/share/applications', '/usr/local/share/applications', homeDirectory && path.posix.join(homeDirectory, '.local/share/applications'), '/opt']),
    xdg: {
      config: env.XDG_CONFIG_HOME || (homeDirectory ? path.posix.join(homeDirectory, '.config') : null),
      data: env.XDG_DATA_HOME || (homeDirectory ? path.posix.join(homeDirectory, '.local/share') : null),
      cache: env.XDG_CACHE_HOME || (homeDirectory ? path.posix.join(homeDirectory, '.cache') : null),
      state: env.XDG_STATE_HOME || (homeDirectory ? path.posix.join(homeDirectory, '.local/state') : null),
    },
  };
}

const COMMAND_HINTS = Object.freeze({
  win32: [
    /\b(?:Get-ChildItem|Get-Process|Get-Service|Set-ItemProperty|Get-NetTCPConnection|Start-Process)\b/i,
    /\b(?:taskkill|reg|sc|powershell|pwsh|cmd)(?:\.exe)?\b/i,
    /(?:^|[\s"'=])[A-Za-z]:\\/,
  ],
  darwin: [
    /\b(?:launchctl|osascript|system_profiler|networksetup|pmset|diskutil)\b/i,
    /\bdefaults\s+(?:read|write|delete)\b/i,
    /\bopen\s+-a\b/i,
  ],
  linux: [
    /\b(?:systemctl|journalctl|loginctl|xdg-open)\b/i,
    /\b(?:apt|apt-get|dnf|yum|pacman|zypper)\b/i,
    /\bapk\s+(?:add|del|update|upgrade)\b/i,
    /(?:^|[\s"'=])\/(?:proc|sys)\//,
  ],
});

export function detectCommandPlatformMismatch(command, platform = process.platform) {
  const selected = normalizedPlatform(platform);
  const source = String(command || '');
  for (const [candidate, patterns] of Object.entries(COMMAND_HINTS)) {
    if (candidate === selected) continue;
    if (patterns.some((pattern) => pattern.test(source))) {
      return {
        hostPlatform: platformId(selected),
        commandPlatform: platformId(candidate),
        message: `This command appears to target ${platformName(candidate)}, but ForgeLink is running on ${platformName(selected)}.`,
      };
    }
  }
  return null;
}

export function assertCommandMatchesPlatform(command, platform = process.platform) {
  const mismatch = detectCommandPlatformMismatch(command, platform);
  if (mismatch) {
    const error = new Error(mismatch.message);
    error.code = 'PLATFORM_COMMAND_MISMATCH';
    error.details = mismatch;
    throw error;
  }
  return true;
}
