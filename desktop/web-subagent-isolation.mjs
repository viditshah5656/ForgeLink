import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SKIP_DIRECTORIES = new Set([
  '.git', '.svn', '.hg', '.codex', '.cursor', '.claude', '.gemini', '.antigravity',
  '.aws', '.ssh', '.azure', '.kube', '.gnupg', '.docker', '.config',
  'node_modules', '.pnpm-store', '.yarn', '.venv', 'venv', '__pycache__',
  '.next', '.nuxt', '.vite', '.cache', '.forgelink-tmp', '.forgelink-npm-cache', 'coverage', 'dist', 'build',
  'target', 'tmp', 'temp', '.turbo', '.parcel-cache',
]);
const SENSITIVE_NAME = /(?:^\.env(?:\.|$)|^\.(?:npmrc|pypirc|netrc)$|(?:^|[._-])(?:secret|secrets|credential|credentials|token|tokens|private[._-]?key|api[._-]?key|service[._-]?account)(?:[._-]|$)|^id_(?:rsa|ed25519|ecdsa)(?:\.|$)|\.(?:pem|p12|pfx|key|keystore)$)/i;
const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PATCH_BYTES = 256 * 1024;

function abortIfNeeded(signal) {
  if (signal?.aborted) throw signal.reason || new Error('Subagent workspace preparation aborted');
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeRelative(input) {
  if (typeof input !== 'string' || !input.trim() || path.isAbsolute(input) || /[\x00-\x1f]/.test(input)) {
    throw new Error('Allowed paths must be nonempty relative paths without control characters');
  }
  const normalized = input.replaceAll('\\', '/').replace(/\/$/, '') || '.';
  if (normalized === '.') return normalized;
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error(`Unsafe relative path: ${input}`);
  }
  return parts.join('/');
}

function excluded(relative) {
  const parts = relative.split('/');
  return parts.some((part) => SKIP_DIRECTORIES.has(part.toLowerCase()) || SENSITIVE_NAME.test(part));
}

function normalizeAllowed(allowedPaths) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    throw new Error('Subagent workspaces require explicit allowedPaths');
  }
  const allowed = [...new Set(allowedPaths.map(safeRelative))];
  if (allowed.some(excluded)) throw new Error('An allowed path names an excluded secret or generated directory');
  return allowed.includes('.') ? ['.'] : allowed;
}

function isAllowed(relative, allowed) {
  return allowed.includes('.') || allowed.some((entry) => relative === entry || relative.startsWith(`${entry}/`));
}

async function hashFile(file) {
  const bytes = await fs.readFile(file);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

async function gitVisiblePaths(root) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
    });
    return [...new Set(stdout.toString('utf8').split('\0').filter(Boolean).map((item) => item.replaceAll('\\', '/')))];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 128 || /not a git repository/i.test(String(error.stderr || ''))) return null;
    throw new Error(`Cannot determine Git-visible source files: ${error.message}`);
  }
}

async function gitIgnores(root, relative) {
  try {
    await execFileAsync('git', ['check-ignore', '--no-index', '--quiet', '--', relative], { cwd: root });
    return true;
  } catch (error) {
    if (error.code === 1 || error.code === 128 || error.code === 'ENOENT') return false;
    throw error;
  }
}

async function listAllowedFiles(root, allowed, { signal, excludeRoot, maxFiles, maxBytes, maxFileBytes, candidatePaths }) {
  const files = new Map();
  let totalBytes = 0;
  const visit = async (relative) => {
    abortIfNeeded(signal);
    if (relative !== '.' && excluded(relative)) return;
    const absolute = path.resolve(root, relative);
    if (!inside(root, absolute) || (excludeRoot && inside(excludeRoot, absolute))) return;
    let stat;
    try { stat = await fs.lstat(absolute); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) return;
    await assertSafeParent(root, absolute);
    const real = await fs.realpath(absolute);
    if (!inside(root, real)) return;
    if (stat.isDirectory()) {
      const children = await fs.readdir(absolute);
      for (const child of children) {
        if (/[\x00-\x1f]/.test(child)) continue;
        const next = relative === '.' ? child : `${relative}/${child}`;
        await visit(next);
      }
      return;
    }
    if (!stat.isFile() || !isAllowed(relative, allowed)) return;
    if (stat.size > maxFileBytes) throw new Error(`Subagent file limit exceeded: ${relative}`);
    totalBytes += stat.size;
    if (files.size >= maxFiles || totalBytes > maxBytes) throw new Error('Subagent workspace size limit exceeded');
    files.set(relative, { absolute, bytes: stat.size });
  };
  if (candidatePaths) {
    for (const candidate of candidatePaths) {
      if (isAllowed(candidate, allowed) && !excluded(candidate)) await visit(candidate);
    }
  } else {
    for (const entry of allowed) await visit(entry);
  }
  return files;
}

async function statRegularOrMissing(file, root) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
  const real = await fs.realpath(file);
  if (!inside(root, real)) throw new Error(`Path escaped workspace: ${file}`);
  return stat;
}

async function assertSafeParent(root, absolute) {
  const relative = path.relative(root, path.dirname(absolute));
  let cursor = root;
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = await fs.lstat(cursor); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe parent path: ${cursor}`);
  }
}

async function patchForFile(relative, before, after, emptyFile) {
  const left = before || emptyFile;
  const right = after || emptyFile;
  try {
    await execFileAsync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', left, right], { maxBuffer: 384 * 1024 });
    return '';
  } catch (error) {
    if (error.code !== 1) return `Diff unavailable for ${relative}: ${error.message}\n`;
    const raw = String(error.stdout || '');
    return raw.split(/\r?\n/).map((line) => {
      if (line.startsWith('diff --git ')) return `diff --git a/${relative} b/${relative}`;
      if (line.startsWith('--- ')) return before ? `--- a/${relative}` : '--- /dev/null';
      if (line.startsWith('+++ ')) return after ? `+++ b/${relative}` : '+++ /dev/null';
      return line;
    }).join('\n');
  }
}

/**
 * Make a restricted, private snapshot for one ChatGPT web subagent.
 * This limits the files placed in the workspace; the model runtime must also
 * enforce its own OS sandbox so it cannot read or write outside this root.
 */
export async function prepareSubagentWorkspace({
  sourceRoot, id, dataDir, mode = 'read', allowedPaths,
  signal, maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxPatchBytes = DEFAULT_PATCH_BYTES,
}) {
  if (!['read', 'write', 'read_only', 'workspace_write'].includes(mode)) throw new Error('Invalid subagent workspace mode');
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid subagent ID');
  const allowed = normalizeAllowed(allowedPaths);
  maxFiles = Math.min(DEFAULT_MAX_FILES, maxFiles);
  maxBytes = Math.min(DEFAULT_MAX_BYTES, maxBytes);
  maxFileBytes = Math.min(DEFAULT_MAX_FILE_BYTES, maxFileBytes);
  maxPatchBytes = Math.min(DEFAULT_PATCH_BYTES, maxPatchBytes);
  const source = await fs.realpath(path.resolve(sourceRoot));
  const sourceStat = await fs.stat(source);
  if (!sourceStat.isDirectory()) throw new Error('Source root is not a directory');
  const privateData = path.resolve(dataDir);
  await fs.mkdir(privateData, { recursive: true });
  const realData = await fs.realpath(privateData);
  const container = await fs.mkdtemp(path.join(realData, `web-subagent-${id}-`));
  if (!inside(realData, container) || container === realData) throw new Error('Invalid private workspace path');
  const workspaceRoot = path.join(container, 'workspace');
  const baselineRoot = path.join(container, 'baseline');
  const emptyFile = path.join(container, 'empty');
  const settings = { signal, excludeRoot: inside(source, realData) ? realData : null, maxFiles, maxBytes, maxFileBytes };
  let disposed = false;
  let prepared = false;
  try {
    await Promise.all([fs.mkdir(workspaceRoot), fs.mkdir(baselineRoot), fs.writeFile(emptyFile, '')]);
    const sourceFiles = await listAllowedFiles(source, allowed, { ...settings, candidatePaths: await gitVisiblePaths(source) });
    const baseline = new Map();
    for (const [relative, item] of sourceFiles) {
      abortIfNeeded(signal);
      const destination = path.join(workspaceRoot, relative);
      const original = path.join(baselineRoot, relative);
      await Promise.all([fs.mkdir(path.dirname(destination), { recursive: true }), fs.mkdir(path.dirname(original), { recursive: true })]);
      await fs.copyFile(item.absolute, destination);
      await fs.copyFile(destination, original);
      baseline.set(relative, await hashFile(original));
    }
    prepared = true;
    const writable = mode === 'write' || mode === 'workspace_write';
    const diff = async () => {
      if (disposed) throw new Error('Subagent workspace was disposed');
      const currentFiles = await listAllowedFiles(workspaceRoot, allowed, { ...settings, excludeRoot: null });
      const allPaths = [...new Set([...baseline.keys(), ...currentFiles.keys()])].sort();
      const files = [];
      let patch = '';
      let truncated = false;
      for (const relative of allPaths) {
        abortIfNeeded(signal);
        const before = baseline.get(relative) || null;
        if (!before && await gitIgnores(source, relative)) continue;
        const after = currentFiles.has(relative) ? await hashFile(currentFiles.get(relative).absolute) : null;
        if (before?.sha256 === after?.sha256) continue;
        const status = !before ? 'added' : !after ? 'deleted' : 'modified';
        files.push({ path: relative, status, beforeSha256: before?.sha256 || null, afterSha256: after?.sha256 || null, bytesBefore: before?.bytes || 0, bytesAfter: after?.bytes || 0 });
        if (truncated) continue;
        if ((before?.bytes || 0) > 128 * 1024 || (after?.bytes || 0) > 128 * 1024) {
          patch += `diff --git a/${relative} b/${relative}\nBinary or large file (${status})\n`;
        } else {
          patch += await patchForFile(relative, before ? path.join(baselineRoot, relative) : null, after ? currentFiles.get(relative).absolute : null, emptyFile);
        }
        if (Buffer.byteLength(patch) > maxPatchBytes) {
          patch = Buffer.from(patch).subarray(0, maxPatchBytes).toString('utf8');
          truncated = true;
        }
      }
      return { files, patch, truncated, workspaceRoot, sourceRoot: source, allowedPaths: [...allowed] };
    };
    const apply = async ({ paths, verifySourceAccess, onBeforeWrite } = {}) => {
      if (!writable) throw new Error('Read-only subagent workspaces cannot be applied');
      if (disposed) throw new Error('Subagent workspace was disposed');
      if (!Array.isArray(paths) || paths.length === 0) throw new Error('Explicit changed file paths are required');
      if (typeof verifySourceAccess !== 'function') throw new Error('Source access verification is required before applying subagent changes');
      const selected = [...new Set(paths.map(safeRelative))];
      const review = await diff();
      const changed = new Map(review.files.map((file) => [file.path, file]));
      for (const relative of selected) {
        if (excluded(relative) || !isAllowed(relative, allowed) || !changed.has(relative)) throw new Error(`File is not an allowed reviewed change: ${relative}`);
        const target = path.join(source, relative);
        if (await verifySourceAccess(target, 'write') === false) throw new Error(`Source write denied: ${relative}`);
        await assertSafeParent(source, target);
        const current = await statRegularOrMissing(target, source);
        const hash = current ? await hashFile(target) : null;
        if (hash?.sha256 !== (baseline.get(relative)?.sha256 || undefined) && !(hash === null && !baseline.has(relative))) {
          throw new Error(`Source changed since subagent snapshot: ${relative}`);
        }
        const candidate = path.join(workspaceRoot, relative);
        await assertSafeParent(workspaceRoot, candidate);
        await statRegularOrMissing(candidate, workspaceRoot);
      }
      const applied = [];
      const copyAtomically = async (from, target, suffix = '') => {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.subagent-${id}-${process.pid}${suffix}.tmp`;
        try { await fs.copyFile(from, temp); await fs.rename(temp, target); }
        finally { await fs.rm(temp, { force: true }).catch(() => {}); }
      };
      try {
        for (const relative of selected) {
          abortIfNeeded(signal);
          if (onBeforeWrite) await onBeforeWrite(relative, applied.length);
          const target = path.join(source, relative);
          const candidate = path.join(workspaceRoot, relative);
          if (changed.get(relative).status === 'deleted') await fs.unlink(target);
          else await copyAtomically(candidate, target);
          applied.push(relative);
        }
      } catch (cause) {
        const rollbackErrors = [];
        const rolledBack = [];
        for (const relative of [...applied].reverse()) {
          const target = path.join(source, relative);
          try {
            if (baseline.has(relative)) await copyAtomically(path.join(baselineRoot, relative), target, '-rollback');
            else await fs.rm(target, { force: true });
            rolledBack.push(relative);
          } catch (error) {
            rollbackErrors.push({ path: relative, message: error.message });
          }
        }
        const failure = new Error(rollbackErrors.length
          ? 'Subagent apply failed and rollback was incomplete'
          : 'Subagent apply failed; source changes were rolled back', { cause });
        failure.appliedPaths = applied;
        failure.rolledBackPaths = rolledBack;
        failure.rollbackErrors = rollbackErrors;
        throw failure;
      }
      return { applied, sourceRoot: source };
    };
    const dispose = async () => {
      if (disposed) return;
      let realContainer;
      let stat;
      try { [realContainer, stat] = await Promise.all([fs.realpath(container), fs.lstat(container)]); }
      catch (error) {
        if (error.code === 'ENOENT') { disposed = true; return; }
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(realData, realContainer) || realContainer === realData) {
        throw new Error('Refusing to delete workspace outside private data directory');
      }
      await fs.rm(container, { recursive: true, force: true });
      disposed = true;
    };
    return { root: workspaceRoot, baseline: baselineRoot, mode: writable ? 'write' : 'read', sourceRoot: source, allowedPaths: [...allowed], diff, apply, dispose };
  } catch (error) {
    if (!prepared && inside(realData, container)) await fs.rm(container, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
