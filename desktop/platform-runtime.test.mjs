import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  assertCommandMatchesPlatform,
  availableNativeShells,
  createPlatformDescriptor,
  detectCommandPlatformMismatch,
  isFilesystemRoot,
  pathKey,
  resolveTerminalShell,
} from './platform-runtime.mjs';

const everythingExists = () => true;

test('Windows descriptor exposes Windows-native paths, shells, and permission model', () => {
  const descriptor = createPlatformDescriptor({
    platform: 'win32',
    arch: 'x64',
    env: {
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'C:',
      USERPROFILE: 'C:\\Users\\vidit',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramData: 'C:\\ProgramData',
    },
    homeDirectory: 'C:\\Users\\vidit',
    tempDirectory: 'C:\\Temp',
    existsSync: everythingExists,
  });
  assert.equal(descriptor.id, 'windows');
  assert.equal(descriptor.permissionModel, 'acl+uac');
  assert.equal(descriptor.defaultShell, 'pwsh');
  assert.ok(descriptor.shells.some((shell) => shell.id === 'powershell'));
  assert.ok(descriptor.shells.some((shell) => shell.id === 'cmd'));
  assert.equal(pathKey('C:\\Code\\App', { platform: 'win32', pathApi: path.win32 }), 'c:\\code\\app');
  assert.equal(isFilesystemRoot('C:\\', { platform: 'win32', pathApi: path.win32 }), true);
});

test('macOS descriptor prefers the login shell and reports TCC/SIP boundaries', () => {
  const descriptor = createPlatformDescriptor({
    platform: 'darwin',
    arch: 'arm64',
    env: { SHELL: '/bin/zsh' },
    homeDirectory: '/Users/vidit',
    tempDirectory: '/tmp',
    existsSync: everythingExists,
  });
  assert.equal(descriptor.id, 'macos');
  assert.equal(descriptor.defaultShell, 'zsh');
  assert.ok(descriptor.privacyBoundaries.includes('TCC'));
  assert.ok(descriptor.protectedRoots.includes('/System'));
  assert.ok(descriptor.applicationRoots.includes('/Applications'));
  assert.equal(isFilesystemRoot('/', { platform: 'darwin', pathApi: path.posix }), true);
});

test('Linux descriptor supports XDG paths and multiple native shell families', () => {
  const env = { SHELL: '/usr/bin/fish', XDG_CONFIG_HOME: '/home/vidit/.config-custom' };
  const descriptor = createPlatformDescriptor({
    platform: 'linux',
    arch: 'x64',
    env,
    homeDirectory: '/home/vidit',
    tempDirectory: '/tmp',
    existsSync: everythingExists,
  });
  assert.equal(descriptor.id, 'linux');
  assert.equal(descriptor.defaultShell, 'fish');
  assert.equal(descriptor.xdg.config, '/home/vidit/.config-custom');
  assert.ok(descriptor.packageManagers.includes('apt'));
  assert.ok(descriptor.serviceManagers.includes('systemd'));
  assert.deepEqual(availableNativeShells({ platform: 'linux', env, existsSync: everythingExists }).slice(0, 3), ['fish', 'bash', 'zsh']);
  assert.equal(resolveTerminalShell('fish', { platform: 'linux', env, existsSync: everythingExists }).file, '/usr/bin/fish');
});

test('high-confidence commands for another OS are rejected before shell execution', () => {
  assert.equal(detectCommandPlatformMismatch('Get-Service | Select Name', 'linux')?.commandPlatform, 'windows');
  assert.equal(detectCommandPlatformMismatch('launchctl list', 'win32')?.commandPlatform, 'macos');
  assert.equal(detectCommandPlatformMismatch('systemctl status sshd', 'darwin')?.commandPlatform, 'linux');
  assert.equal(detectCommandPlatformMismatch('git status', 'linux'), null);
  assert.throws(() => assertCommandMatchesPlatform('C:\\Windows\\System32\\cmd.exe /c dir', 'darwin'), (error) => error.code === 'PLATFORM_COMMAND_MISMATCH');
});
