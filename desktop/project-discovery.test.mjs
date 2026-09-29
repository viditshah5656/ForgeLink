import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverProjects, discoverGitRepositories, ProjectIndex } from './project-discovery.mjs';

async function fixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-projects-'));
  try { return await action(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function resolver(root) {
  return async (input) => {
    const resolved = await fs.realpath(input);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('outside approved root');
    return resolved;
  };
}

test('project discovery ranks directory, package, Python, README, and Git signals', async () => await fixture(async (root) => {
  const js = path.join(root, 'ordinary-folder');
  const python = path.join(root, 'python-folder');
  await fs.mkdir(path.join(js, '.git'), { recursive: true });
  await fs.mkdir(python);
  await fs.writeFile(path.join(js, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(js, 'package.json'), JSON.stringify({ name: '@example/meeraai' }));
  await fs.writeFile(path.join(js, 'README.md'), '# MeeraAI\n');
  await fs.writeFile(path.join(python, 'pyproject.toml'), '[project]\nname = "AarnaAI"\n');
  const found = await discoverProjects({ root, query: 'meeraai', resolvePath: resolver(root) });
  assert.equal(found.complete, true);
  assert.equal(found.projects.length, 1);
  assert.equal(found.projects[0].path, js);
  assert.equal(found.projects[0].branch, 'main');
  assert.equal(found.projects[0].dirty, null);
  assert.ok(found.projects[0].signals.includes('package_name'));
  assert.ok(found.projects[0].signals.includes('readme_heading'));
  assert.equal((await discoverProjects({ root, query: 'Meera AI', resolvePath: resolver(root) })).projects[0].path, js);
  const pythonFound = await discoverProjects({ root, query: 'aarnaai', resolvePath: resolver(root) });
  assert.equal(pythonFound.projects[0].path, python);
  assert.ok(pythonFound.projects[0].signals.includes('pyproject_name'));
  const repos = await discoverGitRepositories({ root, resolvePath: resolver(root) });
  assert.deepEqual(repos.repositories.map((item) => item.path), [js]);
  assert.equal(repos.complete, true);
}));

test('discovery prunes dependency trees and reports entry, depth, and result limits', async () => await fixture(async (root) => {
  await fs.mkdir(path.join(root, 'node_modules', 'hidden'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'hidden', 'package.json'), '{"name":"hidden"}');
  for (const name of ['alpha', 'beta', 'gamma']) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'package.json'), `{"name":"${name}"}`);
  }
  const normal = await discoverProjects({ root, resolvePath: resolver(root), maxResults: 2 });
  assert.equal(normal.projects.length, 2);
  assert.equal(normal.matchedCount, 3);
  assert.equal(normal.complete, false);
  assert.ok(normal.stopReasons.includes('result_limit'));
  assert.equal(normal.projects.some((item) => item.path.includes('hidden')), false);
  const bounded = await discoverProjects({ root, resolvePath: resolver(root), maxEntries: 1 });
  assert.equal(bounded.complete, false);
  assert.ok(bounded.stopReasons.includes('entry_limit'));
  assert.equal(bounded.scannedEntries, 1);
  const shallow = await discoverProjects({ root, resolvePath: resolver(root), maxDepth: 1 });
  assert.equal(shallow.complete, true);
  await fs.mkdir(path.join(root, 'alpha', 'nested'));
  await fs.writeFile(path.join(root, 'alpha', 'nested', 'package.json'), '{"name":"deep"}');
  const depthLimited = await discoverProjects({ root, resolvePath: resolver(root), maxDepth: 1 });
  assert.equal(depthLimited.complete, false);
  assert.ok(depthLimited.stopReasons.includes('depth_limit'));
  assert.equal(depthLimited.projects.some((item) => item.name === 'deep'), false);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await discoverProjects({ root, resolvePath: resolver(root), signal: controller.signal });
  assert.equal(cancelled.complete, false);
  assert.deepEqual(cancelled.stopReasons, ['cancelled']);
}));

test('project discovery refuses unapproved children and never follows directory links', async () => await fixture(async (root) => {
  const allowed = path.join(root, 'allowed');
  const blocked = path.join(root, 'blocked');
  await fs.mkdir(allowed);
  await fs.mkdir(blocked);
  await fs.writeFile(path.join(allowed, 'package.json'), '{"name":"safe"}');
  await fs.writeFile(path.join(blocked, 'package.json'), '{"name":"unsafe"}');
  const resolvePath = async (input) => {
    if (input === blocked) throw new Error('outside approved root');
    return await resolver(root)(input);
  };
  const found = await discoverProjects({ root, resolvePath });
  assert.deepEqual(found.projects.map((item) => item.path), [allowed]);
  assert.equal(found.complete, false);
  assert.ok(found.stopReasons.includes('skipped_locations'));
  assert.equal(found.skippedLocationsCount, 1);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-project-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'package.json'), '{"name":"escape"}');
    try { await fs.symlink(outside, path.join(root, 'link'), 'junction'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return; throw error; }
    const linked = await discoverProjects({ root, resolvePath: resolver(root) });
    assert.equal(linked.projects.some((item) => path.basename(item.path) === 'link'), false);
    assert.equal(linked.complete, false);
    assert.ok(linked.skippedLocations.some((item) => item.reason === 'REPARSE_POINT'));
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
}));

test('project index persists aliases, recent use, and revalidates approval on read', async () => await fixture(async (root) => {
  const dataDir = path.join(root, 'state');
  const project = path.join(root, 'my-project');
  await fs.mkdir(project);
  let approved = true;
  const options = { dataDir, resolvePath: resolver(root), isPermanentlyApprovedPath: (target) => approved && target === project };
  const index = new ProjectIndex(options);
  const entry = await index.upsert({ path: project, name: 'MeeraAI', signals: ['git', 'manifest:package.json'], git: true });
  assert.equal(entry.lastSeen, null);
  await index.setAlias('main app', project);
  assert.deepEqual((await index.lookup('main app')).map((item) => item.path), [project]);
  assert.equal((await index.recent()).length, 0);
  await index.recordSeen(project);
  const reloaded = new ProjectIndex(options);
  assert.equal((await reloaded.recent())[0].name, 'MeeraAI');
  assert.deepEqual((await reloaded.lookup('meeraai'))[0].aliases, ['main app']);
  approved = false;
  assert.deepEqual(await reloaded.lookup('meeraai'), []);
  assert.deepEqual(await reloaded.recent(), []);
  await assert.rejects(reloaded.setAlias('escape', project), /permanently approved/);
  assert.equal((await reloaded.removeProject(project)).removed, true);
}));

test('project index serializes concurrent writes and removes aliases with their project', async () => await fixture(async (root) => {
  const projects = ['one', 'two', 'three'].map((name) => path.join(root, name));
  for (const project of projects) await fs.mkdir(project);
  const index = new ProjectIndex({ dataDir: path.join(root, 'state'), resolvePath: resolver(root), isPermanentlyApprovedPath: () => true });
  await Promise.all(projects.map((project) => index.upsert({ path: project, seen: true })));
  assert.equal((await index.list()).length, 3);
  await index.setAlias('primary', projects[0]);
  assert.equal((await index.lookup('primary')).length, 1);
  assert.equal((await index.removeProject(projects[0])).removed, true);
  assert.deepEqual(await index.lookup('primary'), []);
  assert.equal((await index.list()).length, 2);
}));
