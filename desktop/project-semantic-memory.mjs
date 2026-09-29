import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_CONTEXT_ENTRIES = 25;
const DEFAULT_CONTEXT_BYTES = 16 * 1024;
const ALLOWED_KINDS = new Set(['architecture','convention','decision','ownership','verification','transaction','follow_up','preference']);
const ALLOWED_CONFIDENCE = new Set(['verified','observed','inferred']);
const SENSITIVE_PATTERN = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*[^\s]{6,})/i;

function clone(value) { return structuredClone(value); }
function boundedText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new TypeError(name + ' must be nonempty text of at most ' + max + ' characters');
  }
  const clean = value.trim();
  if (SENSITIVE_PATTERN.test(clean)) throw new Error(name + ' appears to contain credential material');
  return clean;
}
function textList(value, name, { maxItems = 40, maxLength = 500 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(name + ' must be an array of at most ' + maxItems + ' items');
  return [...new Set(value.map((item, index) => boundedText(item, name + '[' + index + ']', maxLength)))];
}
function normalizeToken(value) {
  return String(value || '').toLocaleLowerCase().replace(/[^a-z0-9_./\\:-]+/g, ' ').trim();
}
function tokenSet(...values) {
  const set = new Set();
  for (const value of values.flat(Infinity)) {
    for (const token of normalizeToken(value).split(/\s+/)) if (token.length > 1) set.add(token);
  }
  return set;
}
function overlap(a, b) {
  let count = 0;
  for (const item of a) if (b.has(item)) count++;
  return count;
}
async function gitIdentity(root) {
  const dotGit = path.join(root, '.git');
  try {
    const stat = await fs.lstat(dotGit);
    if (stat.isDirectory()) return await fs.realpath(dotGit);
    if (stat.isFile()) {
      const text = await fs.readFile(dotGit, 'utf8');
      const match = text.match(/^\s*gitdir:\s*(.+?)\s*$/im);
      if (match) return await fs.realpath(path.resolve(root, match[1]));
    }
  } catch {}
  return '';
}
async function atomicWrite(file, value, maxBytes) {
  const encoded = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (encoded.length > maxBytes) throw new Error('Project semantic memory exceeds its size limit');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, encoded, { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
function stableEntryKey(entry) {
  const basis = [entry.kind, normalizeToken(entry.title), [...entry.paths].sort().join('|'), [...entry.symbols].sort().join('|')].join('::');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24);
}

export class ProjectSemanticMemory {
  constructor({
    dataDir,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    maxContextEntries = DEFAULT_CONTEXT_ENTRIES,
    maxContextBytes = DEFAULT_CONTEXT_BYTES,
  } = {}) {
    if (!dataDir) throw new TypeError('dataDir is required');
    this.dir = path.join(path.resolve(dataDir), 'project-memory');
    this.indexFile = path.join(this.dir, 'index.json');
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxContextEntries = maxContextEntries;
    this.maxContextBytes = maxContextBytes;
    this.persistChain = Promise.resolve();
  }

  async identifyProject(projectPath) {
    const canonicalPath = await fs.realpath(path.resolve(boundedText(projectPath, 'projectPath', 4000)));
    const stat = await fs.lstat(canonicalPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project memory requires a regular project directory');
    const repositoryIdentity = await gitIdentity(canonicalPath);
    const projectId = crypto.createHash('sha256').update(canonicalPath + '\0' + repositoryIdentity).digest('hex');
    return { projectId, canonicalPath, repositoryIdentity: repositoryIdentity || null, name: path.basename(canonicalPath) };
  }

  projectFile(projectId) {
    if (!/^[a-f0-9]{64}$/.test(projectId)) throw new TypeError('Invalid projectId');
    return path.join(this.dir, projectId + '.json');
  }

  async _readProject(identity) {
    const file = this.projectFile(identity.projectId);
    try {
      const raw = await fs.readFile(file);
      if (raw.length > this.maxBytes) throw new Error('Project semantic memory exceeds its size limit');
      const data = JSON.parse(raw.toString('utf8'));
      if (data?.version !== VERSION || data?.project?.projectId !== identity.projectId || !Array.isArray(data.entries)) {
        throw new Error('Project semantic memory has an unsupported or mismatched format');
      }
      return data;
    } catch (error) {
      if (error?.code === 'ENOENT') return {
        version: VERSION,
        project: identity,
        updatedAt: null,
        entries: [],
      };
      throw error;
    }
  }

  async _saveProject(data) {
    this.persistChain = this.persistChain.then(async () => {
      data.updatedAt = new Date().toISOString();
      await atomicWrite(this.projectFile(data.project.projectId), data, this.maxBytes);
      let index = { version: VERSION, projects: [] };
      try {
        const raw = await fs.readFile(this.indexFile);
        if (raw.length > this.maxBytes) throw new Error('Project memory index exceeds its size limit');
        index = JSON.parse(raw.toString('utf8'));
        if (index?.version !== VERSION || !Array.isArray(index.projects)) throw new Error('Project memory index has an unsupported format');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const summary = { ...data.project, entries: data.entries.length, updatedAt: data.updatedAt };
      const existing = index.projects.findIndex((item) => item.projectId === data.project.projectId);
      if (existing >= 0) index.projects[existing] = summary;
      else index.projects.push(summary);
      if (index.projects.length > 500) index.projects.sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).splice(500);
      await atomicWrite(this.indexFile, index, this.maxBytes);
    });
    return this.persistChain;
  }

  normalizeEntry(input, source = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Memory entry must be an object');
    const kind = boundedText(input.kind, 'kind', 40);
    if (!ALLOWED_KINDS.has(kind)) throw new TypeError('Unsupported memory kind');
    const confidence = input.confidence || 'verified';
    if (!ALLOWED_CONFIDENCE.has(confidence)) throw new TypeError('Unsupported memory confidence');
    const entry = {
      id: typeof input.id === 'string' && /^[a-f0-9-]{16,80}$/i.test(input.id) ? input.id : crypto.randomUUID(),
      key: '',
      kind,
      title: boundedText(input.title, 'title', 300),
      summary: boundedText(input.summary, 'summary', 4000),
      tags: textList(input.tags, 'tags', { maxItems: 30, maxLength: 120 }),
      paths: textList(input.paths, 'paths', { maxItems: 40, maxLength: 1000 }),
      symbols: textList(input.symbols, 'symbols', { maxItems: 40, maxLength: 300 }),
      source: {
        workflowId: source.workflowId ? boundedText(source.workflowId, 'source.workflowId', 200) : null,
        protocolId: source.protocolId ? boundedText(source.protocolId, 'source.protocolId', 200) : null,
        transactionId: source.transactionId ? boundedText(source.transactionId, 'source.transactionId', 200) : null,
        artifactId: source.artifactId ? boundedText(source.artifactId, 'source.artifactId', 200) : null,
        status: source.status ? boundedText(source.status, 'source.status', 40) : null,
      },
      confidence,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      revision: 1,
    };
    if (entry.source.status && !['committed','verified','walkthrough'].includes(entry.source.status)) {
      throw new Error('Only committed or verified engineering outcomes may be promoted to project memory');
    }
    entry.key = stableEntryKey(entry);
    return entry;
  }

  async promote({ projectPath, entries, source = {} } = {}) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 50) throw new TypeError('entries must contain 1 to 50 items');
    const identity = await this.identifyProject(projectPath);
    const data = await this._readProject(identity);
    const now = new Date().toISOString();
    const promoted = [];
    for (const raw of entries) {
      const incoming = this.normalizeEntry(raw, source);
      const existing = data.entries.find((item) => item.key === incoming.key);
      if (existing) {
        existing.title = incoming.title;
        existing.summary = incoming.summary;
        existing.tags = incoming.tags;
        existing.paths = incoming.paths;
        existing.symbols = incoming.symbols;
        existing.source = incoming.source;
        existing.confidence = incoming.confidence;
        existing.updatedAt = now;
        existing.revision = Number(existing.revision || 1) + 1;
        promoted.push(clone(existing));
      } else {
        data.entries.push(incoming);
        promoted.push(clone(incoming));
      }
    }
    if (data.entries.length > this.maxEntries) {
      data.entries.sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      data.entries.length = this.maxEntries;
    }
    await this._saveProject(data);
    return { project: clone(identity), promoted, totalEntries: data.entries.length };
  }

  async context({ projectPath, query = '', paths = [], symbols = [], tags = [], limit = this.maxContextEntries, maxBytes = this.maxContextBytes } = {}) {
    const identity = await this.identifyProject(projectPath);
    const data = await this._readProject(identity);
    const queryTokens = tokenSet(query, paths, symbols, tags);
    const pathTokens = tokenSet(paths);
    const symbolTokens = tokenSet(symbols);
    const tagTokens = tokenSet(tags);
    const kindWeight = { architecture: 7, ownership: 7, convention: 6, decision: 6, verification: 5, transaction: 4, preference: 4, follow_up: 3 };
    const ranked = data.entries.map((entry) => {
      const searchable = tokenSet(entry.title, entry.summary, entry.tags, entry.paths, entry.symbols);
      let score = overlap(queryTokens, searchable) * 4;
      score += overlap(pathTokens, tokenSet(entry.paths)) * 8;
      score += overlap(symbolTokens, tokenSet(entry.symbols)) * 9;
      score += overlap(tagTokens, tokenSet(entry.tags)) * 6;
      score += kindWeight[entry.kind] || 0;
      if (entry.confidence === 'verified') score += 8;
      else if (entry.confidence === 'observed') score += 4;
      const ageMs = Date.now() - new Date(entry.updatedAt || entry.createdAt).getTime();
      if (Number.isFinite(ageMs)) score += Math.max(0, 6 - Math.floor(ageMs / (30 * 86400000)));
      return { entry, score };
    }).sort((a,b) => b.score - a.score || String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt)));
    const chosen = [];
    let bytes = 0;
    for (const item of ranked.slice(0, Math.min(Math.max(1, limit), this.maxContextEntries))) {
      if (queryTokens.size && item.score <= 0) continue;
      const compact = clone(item.entry);
      const encoded = Buffer.byteLength(JSON.stringify(compact), 'utf8');
      if (chosen.length && bytes + encoded > Math.min(maxBytes, this.maxContextBytes)) break;
      chosen.push(compact);
      bytes += encoded;
    }
    const now = new Date().toISOString();
    const usedIds = new Set(chosen.map((item) => item.id));
    let touched = false;
    for (const entry of data.entries) if (usedIds.has(entry.id)) { entry.lastUsedAt = now; touched = true; }
    if (touched) await this._saveProject(data);
    return {
      project: clone(identity),
      snapshotId: 'memsnap_' + crypto.randomUUID(),
      generatedAt: now,
      query: boundedText(query || 'project context', 'query', 4000),
      entries: chosen,
      totalEntries: data.entries.length,
      returnedEntries: chosen.length,
      approxBytes: bytes,
      rule: 'Current repository evidence overrides project memory when they conflict.',
    };
  }

  async status(projectPath) {
    const identity = await this.identifyProject(projectPath);
    const data = await this._readProject(identity);
    const byKind = {};
    const byConfidence = {};
    for (const entry of data.entries) {
      byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
      byConfidence[entry.confidence] = (byConfidence[entry.confidence] || 0) + 1;
    }
    return { project: clone(identity), entries: data.entries.length, byKind, byConfidence, updatedAt: data.updatedAt };
  }
}
