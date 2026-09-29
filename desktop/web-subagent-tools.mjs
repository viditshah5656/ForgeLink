import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024,
  maxWriteBytes: 256 * 1024,
  maxEntries: 100,
  maxSearchFiles: 1200,
  maxSearchResults: 60,
  maxSearchDepth: 12,
  maxSearchMs: 5000,
  maxDirectoryEntriesScanned: 5000,
  maxReadLines: 300,
  maxOutputChars: 24000,
});

const SKIP_DIRECTORY = new Set(['.git', '.hg', '.svn', '.ssh', '.aws', '.config', 'node_modules', 'vendor', 'dist', 'build', '.next', '.cache', '.forgelink-tmp', '.forgelink-npm-cache']);
const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\..*)?|service[-_]?account(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|p12|pfx|key|keystore|jks))$/i;
const SENSITIVE_CONTENT = /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----|(?:(?:API|ACCESS|SECRET|PRIVATE)[_-]?KEY|(?:AUTH|BEARER)[_-]?TOKEN|PASSWORD)\s*[:=]\s*["']?[^\s"']{16,}/i;

function fail(message) { throw new Error(message); }
function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function requireString(value, name, max = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) fail(`${name} must be a nonempty string of at most ${max} characters`);
  return value;
}
function positiveInt(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) fail(`${name} must be an integer from 1 to ${maximum}`);
  return value;
}
function safePath(root, input) {
  const raw = requireString(input, 'path');
  const absolute = path.resolve(root, raw);
  if (!isInside(root, absolute)) fail('Path is outside the subagent root');
  const relative = path.relative(root, absolute);
  // Windows alternate data streams can bypass ordinary filename checks.
  if (process.platform === 'win32' && relative.split(path.sep).some((part) => part.includes(':'))) fail('Alternate data streams are forbidden');
  const parts = relative ? relative.split(path.sep) : [];
  if (process.platform === 'win32' && parts.some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part) || /[. ]$/.test(part))) fail('Windows device names and ambiguous path endings are forbidden');
  if (parts.some((part) => SKIP_DIRECTORY.has(part.toLowerCase()) || SENSITIVE_NAME.test(part))) fail('Sensitive or excluded path is forbidden');
  return absolute;
}
function normalizeScopes(root, values, name) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 100) fail(`${name} must contain 1 to 100 explicit paths`);
  return values.map((value) => {
    const input = typeof value === 'string' ? { path: value } : value;
    if (!input || typeof input !== 'object') fail(`${name} contains an invalid path`);
    const absolute = safePath(root, input.path);
    let kind = input.kind;
    if (kind === undefined) {
      try { kind = fs.statSync(absolute).isDirectory() ? 'directory' : 'file'; }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        kind = /[\\/]$/.test(input.path) || absolute === root ? 'directory' : 'file';
      }
    }
    if (!['file', 'directory'].includes(kind)) fail('Scope kind must be file or directory');
    return Object.freeze({ path: absolute, kind });
  });
}
function covered(scopes, target) {
  return scopes.some((scope) => scope.kind === 'file' ? samePath(scope.path, target) : isInside(scope.path, target));
}
function scopesOverlap(a, b) {
  if (a.kind === 'file' && b.kind === 'file') return samePath(a.path, b.path);
  if (a.kind === 'directory' && b.kind === 'directory') return isInside(a.path, b.path) || isInside(b.path, a.path);
  return a.kind === 'directory' ? isInside(a.path, b.path) : isInside(b.path, a.path);
}
/** Reject a set of concurrent workers whose write scopes intersect. */
export function assertDisjointSubagentWrites(workerScopes) {
  if (!Array.isArray(workerScopes)) fail('workerScopes must be an array');
  for (let i = 0; i < workerScopes.length; i++) {
    const first = workerScopes[i]?.scopes || workerScopes[i];
    if (!Array.isArray(first?.writePaths)) fail('Each worker must provide normalized scopes.writePaths');
    for (let j = i + 1; j < workerScopes.length; j++) {
      const second = workerScopes[j]?.scopes || workerScopes[j];
      if (!Array.isArray(second?.writePaths)) fail('Each worker must provide normalized scopes.writePaths');
      for (const left of first.writePaths) for (const right of second.writePaths) {
        if (scopesOverlap(left, right)) fail(`Concurrent subagents have overlapping write scopes: ${left.path} and ${right.path}`);
      }
    }
  }
  return true;
}
function relative(root, target) { return path.relative(root, target) || '.'; }
function clampOutput(value, maxChars) {
  const json = JSON.stringify(value);
  if (json.length <= maxChars) return value;
  // Return an explicit truncation marker rather than invalid JSON.
  return { error: 'Result exceeds output limit', truncated: true };
}
function responseTool(name, description, properties) {
  return {
    type: 'function', name, description, strict: true,
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  };
}
const str = (description) => ({ type: 'string', description });
const integer = (description) => ({ type: 'integer', description });

/**
 * Filesystem functions for one model-backed worker. All paths are relative to root unless
 * absolute, and must be inside an explicit read scope. Write mode additionally requires
 * writePaths; the caller must assign disjoint write scopes across concurrent workers.
 * No shell, network, terminal, or process capability is exposed.
 *
 * execute() returns a JSON-serializable object. Callers should JSON.stringify it as a
 * Responses API function_call_output. Tool errors throw; callers should report the error
 * as a tool result without terminating unrelated workers.
 */
export function createSubagentTools({ root, allowedPaths, mode = 'read', writePaths, limits = {} }) {
  if (!['read', 'write'].includes(mode)) fail('mode must be read or write');
  const rootInput = requireString(root, 'root');
  const canonicalRoot = fs.realpathSync.native(path.resolve(rootInput));
  if (!fs.statSync(canonicalRoot).isDirectory()) fail('root must be a directory');
  const readScopes = normalizeScopes(canonicalRoot, allowedPaths, 'allowedPaths');
  const writeScopes = mode === 'write' ? normalizeScopes(canonicalRoot, writePaths, 'writePaths') : [];
  for (const scope of writeScopes) if (!covered(readScopes, scope.path)) fail('Every write scope must be inside a read scope');
  const cap = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_LIMITS)) fail(`Unknown limit: ${key}`);
    positiveInt(value, key, DEFAULT_LIMITS[key]);
    cap[key] = value;
  }
  if (cap.maxWriteBytes > cap.maxFileBytes) fail('maxWriteBytes cannot exceed maxFileBytes');
  const specs = [
    responseTool('fs_list', 'List one permitted directory. Sensitive entries are omitted.', { path: str('Directory path relative to worker root, or .'), maxEntries: integer(`Maximum entries, 1-${cap.maxEntries}`) }),
    responseTool('fs_read', 'Read a bounded range of UTF-8 text lines from one permitted file.', { path: str('File path relative to worker root'), startLine: integer('First line, starting at 1'), endLine: integer(`Last line, inclusive; at most ${cap.maxReadLines} lines`) }),
    responseTool('fs_search', 'Search permitted UTF-8 files for a literal text query. Skips excluded directories and sensitive files.', { path: str('File or directory path relative to worker root'), query: str('Literal text, not a regular expression'), maxResults: integer(`Maximum matches, 1-${cap.maxSearchResults}`) }),
  ];
  if (mode === 'write') specs.push(
    responseTool('fs_write', 'Create or replace a UTF-8 text file in a write scope. expectedSha256 must be null for a new file, or the exact current SHA-256 for replacement.', { path: str('Target file path'), content: str('Complete new UTF-8 content'), expectedSha256: { type: ['string', 'null'], description: 'Current lowercase SHA-256 hex digest, or null for create only' } }),
    responseTool('fs_replace', 'Replace one exact text occurrence in a write-scoped UTF-8 file, guarded by the current SHA-256.', { path: str('Target file path'), oldText: str('Exact existing text, appearing once'), newText: str('Replacement text'), expectedSha256: str('Current lowercase SHA-256 hex digest') }),
    responseTool('fs_delete', 'Delete one write-scoped regular file, guarded by the current SHA-256.', { path: str('Target file path'), expectedSha256: str('Current lowercase SHA-256 hex digest') }),
  );
  const locks = new Map();

  async function noSymlinks(target, { allowMissingLeaf = false } = {}) {
    const components = path.relative(canonicalRoot, target).split(path.sep).filter(Boolean);
    let current = canonicalRoot;
    for (let i = 0; i < components.length; i++) {
      current = path.join(current, components[i]);
      let stat;
      try { stat = await fsp.lstat(current); }
      catch (error) {
        if (error.code === 'ENOENT' && allowMissingLeaf && i === components.length - 1) return null;
        throw error;
      }
      if (stat.isSymbolicLink()) fail('Symbolic links and junctions are forbidden');
      if (i < components.length - 1 && !stat.isDirectory()) fail('A path component is not a directory');
    }
    const actual = await fsp.realpath(target);
    if (!isInside(canonicalRoot, actual) || !samePath(actual, target)) fail('Path resolves outside the permitted root');
    return await fsp.lstat(target);
  }
  async function resolve(input, access, options = {}) {
    const target = safePath(canonicalRoot, input);
    const scopes = access === 'write' ? writeScopes : readScopes;
    if (!covered(scopes, target)) fail(`Path is outside the permitted ${access} scopes`);
    await noSymlinks(target, options);
    return target;
  }
  async function readText(target) {
    const stat = await noSymlinks(target);
    if (!stat.isFile() || stat.size > cap.maxFileBytes) fail(`Only regular text files up to ${cap.maxFileBytes} bytes are permitted`);
    const handle = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > cap.maxFileBytes) fail('File changed or exceeds the size limit');
      const buffer = Buffer.alloc(cap.maxFileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > cap.maxFileBytes) fail('File changed or exceeds the size limit');
      const bytes = buffer.subarray(0, length);
      if (bytes.includes(0)) fail('Binary files are forbidden');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (SENSITIVE_CONTENT.test(content)) fail('Sensitive credential content is forbidden');
      return { content, sha256: sha256(bytes), bytes: bytes.length };
    } finally { await handle.close(); }
  }
  function validateDigest(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('expectedSha256 must be a lowercase 64-character SHA-256 hex digest');
  }
  function validateWriteContent(content) {
    if (typeof content !== 'string') fail('content must be a string');
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > cap.maxWriteBytes || bytes.includes(0)) fail(`Write must be UTF-8 text of at most ${cap.maxWriteBytes} bytes`);
    if (SENSITIVE_CONTENT.test(content)) fail('Sensitive credential content is forbidden');
    return bytes;
  }
  async function inLock(target, fn) {
    const prior = locks.get(target) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    locks.set(target, next);
    await prior;
    try { return await fn(); }
    finally { release(); if (locks.get(target) === next) locks.delete(target); }
  }
  async function atomicWrite(target, bytes, expected) {
    const current = await noSymlinks(target, { allowMissingLeaf: true });
    if (expected === null) {
      if (current) fail('File already exists; expectedSha256 null permits creation only');
      const handle = await fsp.open(target, 'wx', 0o600);
      try { await handle.writeFile(bytes); }
      catch (error) { await handle.close(); await fsp.unlink(target).catch(() => {}); throw error; }
      await handle.close();
      return { path: relative(canonicalRoot, target), sha256: sha256(bytes), bytes: bytes.length, created: true };
    }
    validateDigest(expected);
    if (!current || !current.isFile()) fail('Existing regular file required');
    const before = await readText(target);
    if (before.sha256 !== expected) fail('Content hash mismatch; refresh the file before editing');
    const temp = path.join(path.dirname(target), `.forgelink-agent-${crypto.randomUUID()}.tmp`);
    const handle = await fsp.open(temp, 'wx', current.mode & 0o777);
    try {
      await handle.writeFile(bytes);
      await handle.close();
      await noSymlinks(target);
      const again = await readText(target);
      if (again.sha256 !== expected) fail('Content changed during edit');
      await fsp.rename(temp, target);
    } catch (error) {
      await handle.close().catch(() => {});
      await fsp.unlink(temp).catch(() => {});
      throw error;
    }
    return { path: relative(canonicalRoot, target), sha256: sha256(bytes), bytes: bytes.length, created: false };
  }
  async function execute(name, args = {}) {
    if (!specs.some((tool) => tool.name === name)) fail(`Unknown or unavailable subagent tool: ${name}`);
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('Tool arguments must be an object');
    switch (name) {
      case 'fs_list': {
        const target = await resolve(args.path, 'read');
        const stat = await fsp.stat(target);
        if (!stat.isDirectory()) fail('fs_list requires a directory');
        const maximum = positiveInt(args.maxEntries, 'maxEntries', cap.maxEntries);
        const entries = [];
        let scanned = 0;
        let truncated = false;
        const directory = await fsp.opendir(target);
        for await (const entry of directory) {
          if (++scanned > cap.maxDirectoryEntriesScanned) { truncated = true; break; }
          if (SKIP_DIRECTORY.has(entry.name.toLowerCase()) || SENSITIVE_NAME.test(entry.name) || entry.isSymbolicLink()) continue;
          const item = path.join(target, entry.name);
          if (!covered(readScopes, item)) continue;
          if (entries.length >= maximum) { truncated = true; break; }
          entries.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        return clampOutput({ path: relative(canonicalRoot, target), entries, scanned, truncated }, cap.maxOutputChars);
      }
      case 'fs_read': {
        const target = await resolve(args.path, 'read');
        const startLine = positiveInt(args.startLine, 'startLine', Number.MAX_SAFE_INTEGER);
        const endLine = positiveInt(args.endLine, 'endLine', Number.MAX_SAFE_INTEGER);
        if (endLine < startLine || endLine - startLine + 1 > cap.maxReadLines) fail(`Read must request 1-${cap.maxReadLines} lines in order`);
        const data = await readText(target);
        const lines = data.content.split(/\r?\n/);
        const selected = lines.slice(startLine - 1, endLine).map((text, index) => ({ line: startLine + index, text }));
        return clampOutput({ path: relative(canonicalRoot, target), sha256: data.sha256, totalLines: lines.length, lines: selected }, cap.maxOutputChars);
      }
      case 'fs_search': {
        const target = await resolve(args.path, 'read');
        const query = requireString(args.query, 'query', 200);
        const maximum = positiveInt(args.maxResults, 'maxResults', cap.maxSearchResults);
        const deadline = Date.now() + cap.maxSearchMs;
        const pending = [{ target, depth: 0 }];
        const matches = [];
        let filesScanned = 0;
        let entriesScanned = 0;
        while (pending.length && filesScanned < cap.maxSearchFiles && entriesScanned < cap.maxDirectoryEntriesScanned && matches.length < maximum && Date.now() < deadline) {
          const next = pending.shift();
          const stat = await noSymlinks(next.target).catch(() => null);
          if (!stat) continue;
          if (stat.isDirectory()) {
            if (next.depth >= cap.maxSearchDepth) continue;
            const directory = await fsp.opendir(next.target);
            for await (const entry of directory) {
              if (++entriesScanned > cap.maxDirectoryEntriesScanned) break;
              if (entry.isSymbolicLink() || SKIP_DIRECTORY.has(entry.name.toLowerCase()) || SENSITIVE_NAME.test(entry.name)) continue;
              const child = path.join(next.target, entry.name);
              if (covered(readScopes, child)) pending.push({ target: child, depth: next.depth + 1 });
            }
          } else if (stat.isFile()) {
            filesScanned++;
            if (stat.size > cap.maxFileBytes) continue;
            let data;
            try { data = await readText(next.target); } catch { continue; }
            for (const [index, line] of data.content.split(/\r?\n/).entries()) {
              if (line.includes(query)) matches.push({ path: relative(canonicalRoot, next.target), line: index + 1, preview: line.slice(0, 300) });
              if (matches.length >= maximum) break;
            }
          }
        }
        return clampOutput({ matches, filesScanned, entriesScanned, truncated: pending.length > 0 || matches.length >= maximum || filesScanned >= cap.maxSearchFiles || entriesScanned >= cap.maxDirectoryEntriesScanned || Date.now() >= deadline }, cap.maxOutputChars);
      }
      case 'fs_write': {
        const target = await resolve(args.path, 'write', { allowMissingLeaf: true });
        const bytes = validateWriteContent(args.content);
        if (args.expectedSha256 !== null) validateDigest(args.expectedSha256);
        return await inLock(target, () => atomicWrite(target, bytes, args.expectedSha256));
      }
      case 'fs_replace': {
        const target = await resolve(args.path, 'write');
        const oldText = requireString(args.oldText, 'oldText', cap.maxFileBytes);
        if (typeof args.newText !== 'string') fail('newText must be a string');
        validateDigest(args.expectedSha256);
        return await inLock(target, async () => {
          const data = await readText(target);
          if (data.sha256 !== args.expectedSha256) fail('Content hash mismatch; refresh the file before editing');
          const first = data.content.indexOf(oldText);
          if (first < 0 || data.content.indexOf(oldText, first + oldText.length) >= 0) fail('oldText must occur exactly once');
          const bytes = validateWriteContent(data.content.slice(0, first) + args.newText + data.content.slice(first + oldText.length));
          return await atomicWrite(target, bytes, args.expectedSha256);
        });
      }
      case 'fs_delete': {
        const target = await resolve(args.path, 'write');
        validateDigest(args.expectedSha256);
        return await inLock(target, async () => {
          const data = await readText(target);
          if (data.sha256 !== args.expectedSha256) fail('Content hash mismatch; refresh the file before deleting');
          await noSymlinks(target);
          await fsp.unlink(target);
          return { path: relative(canonicalRoot, target), deleted: true };
        });
      }
    }
  }
  return Object.freeze({ specs: Object.freeze(specs), execute, scopes: Object.freeze({ root: canonicalRoot, allowedPaths: readScopes, writePaths: writeScopes, mode }) });
}
