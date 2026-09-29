import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const PRUNE = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', 'dist', 'build', 'target', 'vendor', 'coverage']);
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'composer.json', 'Gemfile', 'Makefile', 'CMakeLists.txt']);
const MAX_SKIPPED = 40;
const MAX_INDEX_BYTES = 1024 * 1024;

function clamp(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function key(value) {
  return process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
}

function within(root, target) {
  const relative = path.relative(root, target);
  return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function boundedName(value, label = 'Name') {
  const result = String(value ?? '').trim();
  if (!result || result.length > 100 || /[\r\n\0]/.test(result)) throw new Error(`${label} must be a single line of 1–100 characters`);
  return result;
}

function matchScore(query, candidate) {
  if (!query || !candidate) return 0;
  const expected = query.toLocaleLowerCase();
  const actual = candidate.toLocaleLowerCase();
  const unscoped = actual.split('/').at(-1);
  const compact = (value) => value.replace(/[\s._-]+/g, '');
  const normalizedQuery = compact(expected);
  const normalizedName = compact(unscoped);
  if (!normalizedQuery) return 0;
  if (actual === expected || unscoped === expected) return 70;
  if (normalizedName === normalizedQuery) return 66;
  if (actual.startsWith(expected) || unscoped.startsWith(expected)) return 48;
  if (normalizedName.startsWith(normalizedQuery)) return 44;
  if (actual.includes(expected)) return 30;
  if (normalizedName.includes(normalizedQuery)) return 26;
  return 0;
}

async function readSmallRegular(file, maxBytes, resolvePath, root) {
  try {
    const lexical = await fs.lstat(file);
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.size > maxBytes) return null;
    const approved = await resolvePath(file);
    if (!within(root, approved)) return null;
    const actual = await fs.lstat(approved);
    if (!actual.isFile() || actual.isSymbolicLink() || actual.size > maxBytes) return null;
    const handle = await fs.open(approved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (!(await handle.stat()).isFile()) return null;
      const data = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      return bytesRead > maxBytes ? null : data.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  } catch {
    return null;
  }
}

async function metadata(directory, names, root, resolvePath, deadline) {
  const files = new Set(names.filter((name) => MANIFESTS.has(name) || /^README(?:\.[^.]+)?$/i.test(name) || name.endsWith('.code-workspace')));
  const result = { files: [...files].sort(), git: names.includes('.git'), branch: null, packageName: null, pyprojectName: null, readmeHeading: null, workspaceNames: [...files].filter((name) => name.endsWith('.code-workspace')).map((name) => name.slice(0, -'.code-workspace'.length)) };
  if (result.git) {
    const head = await readSmallRegular(path.join(directory, '.git', 'HEAD'), 512, resolvePath, root);
    const branch = head?.match(/^ref:\s+refs\/heads\/([^\r\n]{1,100})\s*$/);
    if (branch) result.branch = branch[1];
  }
  if (Date.now() >= deadline) return result;
  if (files.has('package.json')) {
    const raw = await readSmallRegular(path.join(directory, 'package.json'), 64 * 1024, resolvePath, root);
    if (raw) { try { const parsed = JSON.parse(raw); if (typeof parsed.name === 'string') result.packageName = parsed.name.slice(0, 100); } catch {} }
  }
  if (Date.now() >= deadline) return result;
  if (files.has('pyproject.toml')) {
    const raw = await readSmallRegular(path.join(directory, 'pyproject.toml'), 64 * 1024, resolvePath, root);
    const section = raw?.match(/^\[(?:project|tool\.poetry)\]\s*\r?\n([\s\S]*?)(?=^\[|$)/m)?.[1];
    const parsed = section?.match(/^name\s*=\s*["']([^"'\r\n]{1,100})["']/m);
    if (parsed) result.pyprojectName = parsed[1];
  }
  if (Date.now() >= deadline) return result;
  const readme = [...files].find((name) => /^README(?:\.[^.]+)?$/i.test(name));
  if (readme) {
    const raw = await readSmallRegular(path.join(directory, readme), 16 * 1024, resolvePath, root);
    const heading = raw?.match(/^#\s+([^\r\n]{1,100})/m);
    if (heading) result.readmeHeading = heading[1].trim();
  }
  return result;
}

function projectRecord(directory, names, details, query, mode) {
  const manifestFiles = details.files.filter((name) => MANIFESTS.has(name));
  const projectSignal = details.git || manifestFiles.length > 0 || details.workspaceNames.length > 0 || (names.includes('src') && details.readmeHeading);
  if (!projectSignal || (mode === 'git' && !details.git)) return null;
  const directoryScore = query ? matchScore(query, path.basename(directory)) : 0;
  const packageScore = query ? matchScore(query, details.packageName) : 0;
  const pythonScore = query ? matchScore(query, details.pyprojectName) : 0;
  const readmeScore = query ? matchScore(query, details.readmeHeading) : 0;
  const workspaceScore = query ? Math.max(0, ...details.workspaceNames.map((name) => matchScore(query, name))) : 0;
  const match = Math.max(directoryScore, packageScore, pythonScore, readmeScore, workspaceScore);
  if (query && !match) return null;
  const signals = [
    ...(details.git ? ['git'] : []),
    ...manifestFiles.map((name) => `manifest:${name}`),
    ...(details.workspaceNames.length ? ['vscode_workspace'] : []),
    ...(directoryScore ? ['directory_name'] : []),
    ...(packageScore ? ['package_name'] : []),
    ...(pythonScore ? ['pyproject_name'] : []),
    ...(readmeScore ? ['readme_heading'] : []),
    ...(workspaceScore ? ['workspace_name'] : []),
  ];
  return {
    path: directory,
    name: details.packageName || details.pyprojectName || path.basename(directory),
    score: match + (details.git ? 12 : 0) + Math.min(manifestFiles.length, 3) * 7 + (details.workspaceNames.length ? 6 : 0),
    signals,
    git: details.git,
    branch: details.branch,
    dirty: null,
    packageName: details.packageName,
    pyprojectName: details.pyprojectName,
    readmeHeading: details.readmeHeading,
    manifests: manifestFiles,
  };
}

/** Search only an approved root. resolvePath must enforce current read approval and return its canonical path. */
export async function discoverProjects({
  root, query = '', mode = 'project', maxDepth = 8, maxEntries = 50000,
  maxResults = 100, maxTimeMs = 15000, resolvePath, signal,
} = {}) {
  if (typeof resolvePath !== 'function') throw new Error('Project discovery requires an approved-path resolver');
  if (typeof root !== 'string' || !root) throw new Error('A search root is required');
  if (!['project', 'git'].includes(mode)) throw new Error('Unsupported discovery mode');
  if (typeof query !== 'string' || query.length > 100 || /[\r\n\0]/.test(query)) throw new Error('Invalid project query');
  const limits = { maxDepth: clamp(maxDepth, 8, 32), maxEntries: clamp(maxEntries, 50000, 500000), maxResults: clamp(maxResults, 100, 500), maxTimeMs: clamp(maxTimeMs, 15000, 60000) };
  const base = await resolvePath(root);
  const baseStat = await fs.lstat(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('Project search root must be a regular directory');
  const deadline = Date.now() + limits.maxTimeMs;
  const queue = [{ directory: base, depth: 0 }];
  const found = [];
  const skippedLocations = [];
  let skippedLocationsCount = 0;
  let scannedEntries = 0;
  let scannedDirectories = 0;
  let matchedCount = 0;
  const stopReasons = new Set();
  const skip = (file, error) => {
    skippedLocationsCount++;
    if (skippedLocations.length < MAX_SKIPPED) skippedLocations.push({ path: file, reason: error?.code || error?.message || 'UNAVAILABLE' });
  };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (signal?.aborted) { stopReasons.add('cancelled'); break; }
    if (Date.now() >= deadline) { stopReasons.add('time_limit'); break; }
    const { directory, depth } = queue[cursor];
    let approved;
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { skip(directory, { code: 'REPARSE_POINT' }); continue; }
      approved = await resolvePath(directory);
      if (!within(base, approved)) { skip(directory, { code: 'OUTSIDE_SEARCH_ROOT' }); continue; }
    } catch (error) { skip(directory, error); continue; }
    scannedDirectories++;
    const names = [];
    const children = [];
    let handle;
    try {
      handle = await fs.opendir(approved);
      for await (const entry of handle) {
        if (signal?.aborted) { stopReasons.add('cancelled'); break; }
        if (Date.now() >= deadline) { stopReasons.add('time_limit'); break; }
        if (scannedEntries >= limits.maxEntries) { stopReasons.add('entry_limit'); break; }
        scannedEntries++;
        if (entry.isSymbolicLink()) { skip(path.join(approved, entry.name), { code: 'REPARSE_POINT' }); continue; }
        names.push(entry.name);
        if (entry.isDirectory() && !PRUNE.has(entry.name.toLocaleLowerCase())) {
          if (depth < limits.maxDepth) children.push(path.join(approved, entry.name));
          else stopReasons.add('depth_limit');
        }
      }
    } catch (error) {
      if (!['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'ENOTDIR', 'EMFILE'].includes(error?.code)) throw error;
      skip(approved, error);
    } finally { await handle?.close().catch(() => {}); }
    const details = await metadata(approved, names, base, resolvePath, deadline);
    const record = projectRecord(approved, names, details, query.trim(), mode);
    if (record) { matchedCount++; found.push(record); }
    for (const child of children) queue.push({ directory: child, depth: depth + 1 });
    if (stopReasons.has('entry_limit') || stopReasons.has('time_limit') || stopReasons.has('cancelled')) break;
  }
  found.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (found.length > limits.maxResults) stopReasons.add('result_limit');
  if (skippedLocationsCount) stopReasons.add('skipped_locations');
  return {
    root: base, query: query.trim(), mode, projects: found.slice(0, limits.maxResults),
    complete: stopReasons.size === 0, stopReasons: [...stopReasons],
    scannedEntries, scannedDirectories, matchedCount,
    skippedLocationsCount, skippedLocations, limits,
  };
}

export async function discoverGitRepositories(options) {
  const result = await discoverProjects({ ...options, mode: 'git' });
  const { projects, ...rest } = result;
  return { ...rest, repositories: projects };
}

/** A private index of explicitly discovered or used projects; it never expands filesystem approval. */
export class ProjectIndex {
  constructor({ dataDir, resolvePath, isPermanentlyApprovedPath }) {
    if (typeof resolvePath !== 'function' || typeof isPermanentlyApprovedPath !== 'function') throw new Error('Project index requires approval callbacks');
    this.file = path.join(dataDir, 'project-index.json');
    this.resolvePath = resolvePath;
    this.isPermanentlyApprovedPath = isPermanentlyApprovedPath;
    this.pending = Promise.resolve();
  }

  async load() {
    let raw;
    try { raw = await fs.readFile(this.file); }
    catch (error) { if (error?.code === 'ENOENT') return { version: 1, projects: [], aliases: [] }; throw error; }
    if (raw.length > MAX_INDEX_BYTES) throw new Error('Project index exceeds its size limit');
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Project index is invalid JSON'); }
    if (data?.version !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.aliases)) throw new Error('Project index has an unsupported format');
    return data;
  }

  async save(data) {
    const encoded = Buffer.from(JSON.stringify(data, null, 2) + '\n');
    if (encoded.length > MAX_INDEX_BYTES) throw new Error('Project index exceeds its size limit');
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, encoded, { mode: 0o600 }); await fs.rename(temporary, this.file); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async approved(input) {
    const target = await this.resolvePath(input);
    if (!this.isPermanentlyApprovedPath(target)) throw new Error('Only permanently approved project folders may be indexed');
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Indexed project must be a regular directory');
    return target;
  }

  mutate(action) {
    const next = this.pending.then(async () => {
      const data = await this.load();
      const result = await action(data);
      await this.save(data);
      return result;
    });
    this.pending = next.catch(() => {});
    return next;
  }

  async upsert({ path: input, name, signals = [], git = false, seen = false }) {
    const target = await this.approved(input);
    const cleanName = boundedName(name || path.basename(target));
    const cleanSignals = [...new Set(signals.filter((item) => typeof item === 'string' && /^[a-z0-9:_-]{1,60}$/i.test(item)))].slice(0, 20);
    return await this.mutate(async (data) => {
      const now = new Date().toISOString();
      let entry = data.projects.find((item) => key(item.path) === key(target));
      if (entry) {
        entry.name = cleanName;
        entry.signals = cleanSignals;
        entry.git = Boolean(git);
        if (seen) entry.lastSeen = now;
      } else {
        if (data.projects.length >= 500) throw new Error('Project index is limited to 500 entries');
        entry = { path: target, name: cleanName, signals: cleanSignals, git: Boolean(git), indexedAt: now, lastSeen: seen ? now : null };
        data.projects.push(entry);
      }
      return { ...entry };
    });
  }

  async recordSeen(input) {
    const target = await this.approved(input);
    return await this.mutate(async (data) => {
      const entry = data.projects.find((item) => key(item.path) === key(target));
      if (!entry) throw new Error('Project must be indexed before recording activity');
      entry.lastSeen = new Date().toISOString();
      return { ...entry };
    });
  }

  async setAlias(alias, input) {
    const cleanAlias = boundedName(alias, 'Alias');
    if (/[\\/:*?"<>|]/.test(cleanAlias)) throw new Error('Alias contains a path character');
    const target = await this.approved(input);
    return await this.mutate(async (data) => {
      if (!data.projects.some((item) => key(item.path) === key(target))) throw new Error('Project must be indexed before adding an alias');
      const existing = data.aliases.find((item) => item.alias.toLocaleLowerCase() === cleanAlias.toLocaleLowerCase());
      if (existing) existing.path = target;
      else {
        if (data.aliases.length >= 500) throw new Error('Project alias index is full');
        data.aliases.push({ alias: cleanAlias, path: target });
      }
      return { alias: cleanAlias, path: target };
    });
  }

  async removeAlias(alias) {
    const cleanAlias = boundedName(alias, 'Alias');
    return await this.mutate(async (data) => {
      const before = data.aliases.length;
      data.aliases = data.aliases.filter((item) => item.alias.toLocaleLowerCase() !== cleanAlias.toLocaleLowerCase());
      return { removed: data.aliases.length !== before };
    });
  }

  async removeProject(input) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('Project path is required');
    // Removing stale metadata is allowed even after a folder disappears or its approval is revoked.
    const target = path.resolve(input);
    return await this.mutate(async (data) => {
      const before = data.projects.length;
      data.projects = data.projects.filter((item) => key(item.path) !== key(target));
      data.aliases = data.aliases.filter((item) => key(item.path) !== key(target));
      return { removed: data.projects.length !== before };
    });
  }

  async list({ query = '', limit = 100, recent = false } = {}) {
    if (typeof query !== 'string' || query.length > 100 || /[\r\n\0]/.test(query)) throw new Error('Invalid project query');
    const data = await this.load();
    const result = [];
    for (const item of data.projects.slice(0, 500)) {
      try {
        const target = await this.approved(item.path);
        const aliases = data.aliases.filter((alias) => key(alias.path) === key(target)).map((alias) => alias.alias);
        const score = Math.max(matchScore(query, item.name), ...aliases.map((alias) => matchScore(query, alias)), matchScore(query, path.basename(target)));
        if (query && !score) continue;
        if (recent && !item.lastSeen) continue;
        result.push({ path: target, name: item.name, aliases, signals: item.signals, git: item.git, indexedAt: item.indexedAt, lastSeen: item.lastSeen, score });
      } catch {}
    }
    result.sort(recent ? (a, b) => b.lastSeen.localeCompare(a.lastSeen) : (a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return result.slice(0, clamp(limit, 100, 500));
  }

  async lookup(query, options = {}) { return await this.list({ ...options, query }); }
  async recent(limit = 20) { return await this.list({ recent: true, limit }); }
}
