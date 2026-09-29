import assert from 'node:assert/strict';
import test from 'node:test';
import { UnixSystemControl } from './unix-system-control.mjs';

test('macOS status is available while observation still requires owner Read mode', async () => {
  let executions = 0;
  const control = new UnixSystemControl({
    platform: 'darwin',
    getMode: () => 'off',
    existsSync: () => true,
    exec: async () => { executions += 1; return { stdout: '', stderr: '' }; },
    homeDirectory: '/Users/vidit',
  });
  const status = await control.status();
  assert.equal(status.platform.id, 'macos');
  assert.equal(status.mode, 'off');
  assert.equal(status.safety.noImplicitPrivilegeEscalation, true);
  await assert.rejects(() => control.processes(), /System Control is Off/);
  assert.equal(executions, 0);
});

test('Linux process, service, and network observers use bounded native argv calls', async () => {
  const calls = [];
  const control = new UnixSystemControl({
    platform: 'linux',
    getMode: () => 'read',
    existsSync: (file) => ['/bin/ps', '/bin/systemctl', '/usr/sbin/ip'].includes(file),
    exec: async (file, args) => {
      calls.push([file, args]);
      if (file.endsWith('ps')) return { stdout: '10 1 /usr/bin/node 1.2 0.5\n', stderr: '' };
      if (file.endsWith('systemctl')) return { stdout: 'sshd.service loaded active running OpenSSH server\n', stderr: '' };
      if (args[0] === '-brief') return { stdout: 'eth0 UP 192.168.1.5/24\n', stderr: '' };
      return { stdout: 'default via 192.168.1.1 dev eth0\n', stderr: '' };
    },
    homeDirectory: '/home/vidit',
    readdir: async () => [],
  });
  assert.equal((await control.processes()).processes[0].pid, 10);
  assert.equal((await control.services()).services[0].name, 'sshd.service');
  assert.match((await control.network()).defaultRoutes, /default via/);
  assert.equal(calls.some(([file]) => file.includes('sudo')), false);
  assert.equal(control.capabilities().privilegeEscalation, false);
});

test('macOS app launch requires Full mode and exact inventory identity', async () => {
  const calls = [];
  const entries = [{ name: 'Safari.app', isDirectory: () => true, isFile: () => false }];
  const control = new UnixSystemControl({
    platform: 'darwin',
    getMode: () => 'full',
    existsSync: (file) => file === '/usr/bin/open' || file === '/bin/ps',
    exec: async (file, args) => { calls.push([file, args]); return { stdout: '', stderr: '' }; },
    homeDirectory: '/Users/vidit',
    readdir: async (root) => root === '/Applications' ? entries : [],
  });
  const apps = await control.installedApps();
  assert.equal(apps.apps[0].appId, '/Applications/Safari.app');
  const launched = await control.appControl({ action: 'launch', appId: '/Applications/Safari.app' });
  assert.equal(launched.requested, true);
  assert.deepEqual(calls.at(-1), ['/usr/bin/open', ['/Applications/Safari.app']]);
  await assert.rejects(() => control.appControl({ action: 'launch', appId: '/Applications/Fake.app' }), /not present/);
});
