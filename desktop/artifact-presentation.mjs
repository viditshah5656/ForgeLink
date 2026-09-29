import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ARTIFACT_SCHEMA_VERSION = 1;
export const ARTIFACT_TYPES = Object.freeze(['technical-report','implementation-plan','verification-report','architecture-spec','walkthrough','research-report','diagnostic-report','comparison-report','runbook','generic-document']);
export const CERTAINTY = Object.freeze(['verified','observed','inferred','recommended','not-verified','failed']);
export const ARTIFACT_STATES = Object.freeze(['current','stale','superseded']);
export const ARTIFACT_PRESENTATION_MODES = Object.freeze(['natural-document','structured-dashboard']);

const MAX_SECTIONS = 200;
const MAX_BLOCKS = 2000;
const MAX_EVIDENCE = 1000;
const MAX_VERIFICATION = 500;
const MAX_ASSETS = 64;
const MAX_ARTIFACTS = 500;
const MAX_PERSISTED_BYTES = 32 * 1024 * 1024;
const SECRET_PATTERNS = [
  /(?:api[_-]?key|access[_-]?token|secret|password|passwd|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{15,}\b/g,
];
const clone = (value) => structuredClone(value);
function text(value, name, max = 100000, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!allowEmpty && !value.trim())) throw new TypeError(name + ' must be a ' + (allowEmpty ? '' : 'nonempty ') + 'string of at most ' + max + ' characters');
  return value;
}
function array(value, name, max) {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(name + ' must be an array of at most ' + max + ' items');
  return value;
}
function normalizeBlock(block, index) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) throw new TypeError('blocks[' + index + '] must be an object');
  const type = text(block.type, 'blocks[' + index + '].type', 40);
  const allowed = new Set(['paragraph','heading','bullets','table','code','callout','quote','evidence','divider']);
  if (!allowed.has(type)) throw new TypeError('Unsupported block type: ' + type);
  const result = { type };
  if (block.text !== undefined) result.text = text(block.text, 'blocks[' + index + '].text', 20000, true);
  if (block.title !== undefined) result.title = text(block.title, 'blocks[' + index + '].title', 500, true);
  if (block.level !== undefined) { if (!Number.isInteger(block.level) || block.level < 1 || block.level > 4) throw new TypeError('blocks[' + index + '].level must be 1-4'); result.level = block.level; }
  if (block.items !== undefined) result.items = array(block.items, 'blocks[' + index + '].items', 100).map((item, i) => text(item, 'blocks[' + index + '].items[' + i + ']', 5000));
  if (block.language !== undefined) result.language = text(block.language, 'blocks[' + index + '].language', 40, true);
  if (block.content !== undefined) result.content = clone(block.content);
  if (block.columns !== undefined) result.columns = array(block.columns, 'blocks[' + index + '].columns', 50).map((item, i) => text(item, 'blocks[' + index + '].columns[' + i + ']', 200));
  if (block.rows !== undefined) result.rows = array(block.rows, 'blocks[' + index + '].rows', 500).map((row, i) => { if (!Array.isArray(row) || row.length > 50) throw new TypeError('blocks[' + index + '].rows[' + i + '] must contain at most 50 cells'); return row.map((cell) => typeof cell === 'string' ? cell : String(cell ?? '')); });
  if (block.evidenceIds !== undefined) result.evidenceIds = array(block.evidenceIds, 'blocks[' + index + '].evidenceIds', 100).map((item, i) => text(item, 'blocks[' + index + '].evidenceIds[' + i + ']', 128));
  if (block.certainty !== undefined) { if (!CERTAINTY.includes(block.certainty)) throw new TypeError('Unsupported certainty: ' + block.certainty); result.certainty = block.certainty; }
  return result;
}
function normalizeSection(section, index) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) throw new TypeError('sections[' + index + '] must be an object');
  return { id: text(section.id || 'section-' + (index + 1), 'sections[' + index + '].id', 120), title: text(section.title, 'sections[' + index + '].title', 500), blocks: array(section.blocks || [], 'sections[' + index + '].blocks', MAX_BLOCKS).map(normalizeBlock) };
}
function normalizeEvidence(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('evidence[' + index + '] must be an object');
  const certainty = item.certainty || 'observed';
  if (!CERTAINTY.includes(certainty)) throw new TypeError('evidence[' + index + '].certainty is invalid');
  return { id: text(item.id || 'evidence-' + (index + 1), 'evidence[' + index + '].id', 128), claim: text(item.claim, 'evidence[' + index + '].claim', 5000), certainty, source: item.source ? text(item.source, 'evidence[' + index + '].source', 2000) : null, path: item.path ? text(item.path, 'evidence[' + index + '].path', 4000) : null, lines: item.lines ? text(item.lines, 'evidence[' + index + '].lines', 100) : null, reference: item.reference ? text(item.reference, 'evidence[' + index + '].reference', 4000) : null };
}
function normalizeVerification(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('verification[' + index + '] must be an object');
  if (typeof item.passed !== 'boolean') throw new TypeError('verification[' + index + '].passed must be boolean');
  return { id: text(item.id || 'check-' + (index + 1), 'verification[' + index + '].id', 128), check: text(item.check, 'verification[' + index + '].check', 1000), passed: item.passed, evidence: item.evidence ? text(item.evidence, 'verification[' + index + '].evidence', 5000) : '', command: item.command ? text(item.command, 'verification[' + index + '].command', 5000) : null };
}
function normalizeAsset(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('assets[' + index + '] must be an object');
  const id = text(item.id || 'asset-' + (index + 1), 'assets[' + index + '].id', 128);
  const type = item.type || 'image';
  if (type !== 'image') throw new TypeError('assets[' + index + '].type must be image');
  const source = item.source && typeof item.source === 'object' && !Array.isArray(item.source) ? item.source : {};
  if (source.kind !== 'approved-local-file') throw new TypeError('assets[' + index + '].source.kind must be approved-local-file');
  return {
    id,
    type,
    alt: text(item.alt || item.title || 'Artifact image', 'assets[' + index + '].alt', 500),
    title: item.title ? text(item.title, 'assets[' + index + '].title', 500) : '',
    placement: item.placement ? text(item.placement, 'assets[' + index + '].placement', 40) : 'inline',
    role: (() => {
      const candidate = item.role ? text(item.role, 'assets[' + index + '].role', 40).toLowerCase() : (item.placement === 'hero' ? 'logo' : 'generic');
      if (!['logo','screenshot','diagram','photo','generic'].includes(candidate)) throw new TypeError('assets[' + index + '].role is invalid');
      return candidate;
    })(),
    source: {
      kind: 'approved-local-file',
      path: text(source.path, 'assets[' + index + '].source.path', 4000),
    },
  };
}
function collectStrings(value, output = []) { if (typeof value === 'string') output.push(value); else if (Array.isArray(value)) for (const item of value) collectStrings(item, output); else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, output); return output; }
function secretFindings(value) { const joined = collectStrings(value).join('\n'); const findings = []; for (const pattern of SECRET_PATTERNS) { pattern.lastIndex = 0; if (pattern.test(joined)) findings.push(pattern.source); } return findings; }
function isCompletedImplementation(document) {
  if (!document || !['implementation-plan','walkthrough'].includes(document.type)) return false;
  const metadata = document.metadata && typeof document.metadata === 'object' ? document.metadata : {};
  const values = [metadata.phase, metadata.status, metadata.lifecyclePhase, metadata.implementationState]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase());
  return values.some((value) => ['complete','completed','final','verified','done'].includes(value));
}
function isVisualEngineeringBlock(block) {
  if (!block || block.type !== 'code') return false;
  const language = String(block.language || '').trim().toLowerCase();
  if (['mermaid','flowchart','diagram','architecture','image'].includes(language)) return true;
  const content = block.content;
  return Boolean(content && typeof content === 'object' && ['flowchart','diagram','architecture','image'].includes(String(content.kind || '').toLowerCase()));
}
export function parseMarkdownToSections(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return [{ id: 'section-1', title: 'Overview', blocks: [] }];
  }
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let currentSection = null;

  function ensureSection(title = 'Overview') {
    if (!currentSection) {
      currentSection = {
        id: 'section-' + (sections.length + 1),
        title,
        blocks: [],
      };
      sections.push(currentSection);
    }
    return currentSection;
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      currentSection = {
        id: 'section-' + (sections.length + 1),
        title: h2Match[1].trim(),
        blocks: [],
      };
      sections.push(currentSection);
      i++;
      continue;
    }

    const h1Match = line.match(/^#\s+(.+)$/);
    if (h1Match) {
      if (!currentSection) {
        currentSection = {
          id: 'section-' + (sections.length + 1),
          title: h1Match[1].trim(),
          blocks: [],
        };
        sections.push(currentSection);
      } else {
        ensureSection().blocks.push({
          type: 'heading',
          level: 1,
          text: h1Match[1].trim(),
        });
      }
      i++;
      continue;
    }

    const subHMatch = line.match(/^(#{3,4})\s+(.+)$/);
    if (subHMatch) {
      const level = subHMatch[1].length;
      ensureSection().blocks.push({
        type: 'heading',
        level,
        text: subHMatch[2].trim(),
      });
      i++;
      continue;
    }

    const codeMatch = line.match(/^```(\w+)?/);
    if (codeMatch) {
      const lang = codeMatch[1] ? codeMatch[1].trim() : 'text';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith('```')) {
        i++;
      }
      ensureSection().blocks.push({
        type: 'code',
        language: lang,
        text: codeLines.join('\n'),
      });
      continue;
    }

    if (/^(?:---|\*\*\*|___)\s*$/.test(line)) {
      ensureSection().blocks.push({ type: 'divider' });
      i++;
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const rawText = quoteLines.join('\n').trim();
      const calloutMatch = rawText.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*\n)?([\s\S]*)$/i);
      if (calloutMatch) {
        ensureSection().blocks.push({
          type: 'callout',
          title: calloutMatch[1].toUpperCase(),
          text: calloutMatch[2].trim() || calloutMatch[1].toUpperCase(),
        });
      } else {
        ensureSection().blocks.push({
          type: 'quote',
          text: rawText,
        });
      }
      continue;
    }

    if (line.trim().startsWith('|') && line.includes('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 2) {
        const parseRow = (row) => row.split('|').slice(1, -1).map((c) => c.trim());
        const columns = parseRow(tableLines[0]);
        const startIndex = /^\|?[\s\-:|]+\|?$/.test(tableLines[1]) ? 2 : 1;
        const rows = tableLines.slice(startIndex).map(parseRow);
        ensureSection().blocks.push({
          type: 'table',
          columns,
          rows,
        });
        continue;
      }
    }

    if (/^(?:[-*+]|\d+\.)\s+/.test(line.trim())) {
      const items = [];
      while (i < lines.length && /^(?:[-*+]|\d+\.)\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^(?:[-*+]|\d+\.)\s+/, ''));
        i++;
      }
      ensureSection().blocks.push({
        type: 'bullets',
        items,
      });
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('>') &&
      !lines[i].trim().startsWith('|') &&
      !/^(?:[-*+]|\d+\.)\s+/.test(lines[i].trim()) &&
      !/^(?:---|\*\*\*|___)\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      ensureSection().blocks.push({
        type: 'paragraph',
        text: paraLines.join('\n'),
      });
    }
  }

  return sections.length > 0 ? sections : [{ id: 'section-1', title: 'Overview', blocks: [] }];
}

function validateDocument(document) {
  const errors = [];
  if (!document || typeof document !== 'object') return ['Artifact must be an object'];
  if (document.schemaVersion !== ARTIFACT_SCHEMA_VERSION) errors.push('Unsupported schemaVersion: ' + document.schemaVersion);
  if (!ARTIFACT_TYPES.includes(document.type)) errors.push('Unsupported artifact type: ' + document.type);
  if (!document.title || !document.title.trim()) errors.push('Artifact title is required');
  if (!document.metadata || typeof document.metadata !== 'object') errors.push('Artifact metadata is required');
  const hasSections = Array.isArray(document.sections) && document.sections.length > 0;
  const hasContent = typeof document.content === 'string' && document.content.trim().length > 0;
  if (!hasSections && !hasContent) errors.push('At least one artifact section or markdown content is required');
  if (!Array.isArray(document.evidence)) errors.push('Evidence must be an array');
  if (!Array.isArray(document.verification)) errors.push('Verification must be an array');
  if (!Array.isArray(document.assets)) errors.push('Assets must be an array');
  const assetIds = new Set();
  for (const asset of document.assets || []) {
    if (assetIds.has(asset.id)) errors.push('Duplicate artifact asset id: ' + asset.id);
    assetIds.add(asset.id);
  }
  if (hasContent) {
    for (const match of document.content.matchAll(/\]\(asset:([A-Za-z0-9._:-]+)(?:\s+["'][^"']*["'])?\)/g)) {
      if (!assetIds.has(match[1])) errors.push('Markdown references missing artifact asset: ' + match[1]);
    }
  }
  const presentationMode = document.presentationMode || (hasContent ? 'natural-document' : 'structured-dashboard');
  if (!ARTIFACT_PRESENTATION_MODES.includes(presentationMode)) errors.push('Unsupported presentationMode: ' + presentationMode);
  const evidenceIds = new Set((document.evidence || []).map((item) => item.id));
  if (presentationMode === 'structured-dashboard') {
    for (const section of document.sections || []) for (const block of section.blocks || []) {
      for (const evidenceId of block.evidenceIds || []) if (!evidenceIds.has(evidenceId)) errors.push('Block references missing evidence: ' + evidenceId);
      if (block.certainty === 'verified' && (!block.evidenceIds || !block.evidenceIds.length)) errors.push('Verified block has no evidence reference');
    }
  }
  for (const check of document.verification || []) if (check.passed && !check.evidence) errors.push('Passing verification has no evidence: ' + check.check);
  if (isCompletedImplementation(document)) {
    const rawWalkthrough = document.walkthrough || document.content || '';
    const compactWalkthrough = String(rawWalkthrough).replace(/\s+/g, ' ').trim();
    const walkthroughWords = compactWalkthrough ? compactWalkthrough.split(' ').filter(Boolean) : [];
    if (compactWalkthrough.length < 240 || walkthroughWords.length < 35) {
      errors.push('Completed implementation artifacts require a substantive walkthrough rather than a placeholder summary');
    }
    const hasVisual = (document.sections || []).some((section) => (section.blocks || []).some(isVisualEngineeringBlock)) ||
      Boolean(document.content && /```(?:mermaid|flowchart|diagram|architecture)/i.test(document.content));
    if (!hasVisual) {
      errors.push('Completed implementation artifacts require at least one architecture, flowchart, diagram, Mermaid, or image visual block');
    }
  }
  const secrets = secretFindings(document); if (secrets.length) errors.push('Potential secret material detected in artifact (' + secrets.length + ' pattern matches)');
  return [...new Set(errors)];
}
export function createArtifactDocument(input = {}) {
  let rawContent = '';
  if (typeof input.content === 'string' && input.content.trim()) {
    rawContent = input.content.trim();
  } else if (typeof input.markdown === 'string' && input.markdown.trim()) {
    rawContent = input.markdown.trim();
  }

  let title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title && rawContent) {
    const titleMatch = rawContent.match(/^#\s+(.+)$/m);
    if (titleMatch) title = titleMatch[1].trim();
  }
  if (!title) title = 'ForgeLink Artifact';

  const presentationMode = ARTIFACT_PRESENTATION_MODES.includes(input.presentationMode)
    ? input.presentationMode
    : (rawContent ? 'natural-document' : 'structured-dashboard');
  const sectionsInput = Array.isArray(input.sections) ? input.sections : [];

  const document = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    type: ARTIFACT_TYPES.includes(input.type) ? input.type : 'generic-document',
    presentationMode,
    title: text(title, 'title', 500),
    subtitle: input.subtitle ? text(input.subtitle, 'subtitle', 1000) : '',
    metadata: input.metadata && typeof input.metadata === 'object' ? clone(input.metadata) : {},
    summary: input.summary ? text(input.summary, 'summary', 20000) : '',
    sections: array(sectionsInput, 'sections', MAX_SECTIONS).map(normalizeSection),
    evidence: array(input.evidence || [], 'evidence', MAX_EVIDENCE).map(normalizeEvidence),
    verification: array(input.verification || [], 'verification', MAX_VERIFICATION).map(normalizeVerification),
    assets: array(input.assets || [], 'assets', MAX_ASSETS).map(normalizeAsset),
    walkthrough: input.walkthrough ? text(input.walkthrough, 'walkthrough', 20000) : '',
    limitations: array(input.limitations || [], 'limitations', 100).map((item, i) => text(item, 'limitations[' + i + ']', 5000)),
    sourceFingerprint: input.sourceFingerprint ? text(input.sourceFingerprint, 'sourceFingerprint', 500) : null,
    generatedAt: new Date().toISOString()
  };
  if (rawContent) {
    document.content = text(rawContent, 'content', 200000, true);
  }
  const errors = validateDocument(document);
  if (errors.length) throw new Error('Artifact validation failed: ' + errors.join('; '));
  return document;
}
export function validateArtifactDocument(document) { const errors = validateDocument(document); return { valid: errors.length === 0, errors, secretPatterns: secretFindings(document) }; }

export class ArtifactPresentationRuntime {
  constructor({ dataDir } = {}) { if (typeof dataDir !== 'string' || !dataDir.trim()) throw new TypeError('dataDir is required'); this.dataDir = path.resolve(dataDir); this.directory = this.dataDir; this.file = path.join(this.directory, 'index.json'); this.items = new Map(); this.persistChain = Promise.resolve(); this.ready = this._load(); }
  async _load() { await fs.mkdir(this.directory, { recursive: true }); try { const stat = await fs.stat(this.file); if (stat.size > MAX_PERSISTED_BYTES) throw new Error('Artifact index exceeds the 32 MiB safety limit'); const stored = JSON.parse(await fs.readFile(this.file, 'utf8')); if (stored?.version !== 1 || !Array.isArray(stored.artifacts)) throw new Error('Unsupported artifact index format'); for (const item of stored.artifacts.slice(-MAX_ARTIFACTS)) if (item?.id && item.document) this.items.set(item.id, item); } catch (error) { if (error?.code !== 'ENOENT') throw new Error('Could not load presentation artifacts: ' + error.message); } }
  async _persist() { this.persistChain = this.persistChain.then(async () => { const document = { version: 1, savedAt: new Date().toISOString(), artifacts: [...this.items.values()].slice(-MAX_ARTIFACTS) }; const encoded = JSON.stringify(document); if (Buffer.byteLength(encoded, 'utf8') > MAX_PERSISTED_BYTES) throw new Error('Presentation artifact index would exceed the 32 MiB safety limit'); const temp = this.file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp'; await fs.writeFile(temp, encoded, { mode: 0o600 }); try { await fs.rename(temp, this.file); } catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; } }); return this.persistChain; }
  async create(input = {}) { await this.ready; const document = createArtifactDocument(input); const now = new Date().toISOString(); const item = { id: 'artifact_' + crypto.randomUUID(), state: 'current', document, createdAt: now, updatedAt: now, revisions: 1 }; this.items.set(item.id, item); await this._persist(); return clone(item); }
  get(id) { const item = this.items.get(id); if (!item) throw new Error('Presentation artifact not found: ' + id); return clone(item); }
  list({ type, state, limit = 50 } = {}) { return clone([...this.items.values()].reverse().filter((item) => (!type || item.document.type === type) && (!state || item.state === state)).slice(0, Math.max(1, Math.min(200, limit)))); }
  async update(id, input = {}) { await this.ready; const current = this.items.get(id); if (!current) throw new Error('Presentation artifact not found: ' + id); const document = createArtifactDocument({ ...current.document, ...clone(input), schemaVersion: ARTIFACT_SCHEMA_VERSION }); const item = { ...current, state: 'current', document, updatedAt: new Date().toISOString(), revisions: current.revisions + 1 }; this.items.set(id, item); await this._persist(); return clone(item); }
  validate(id) { const item = this.items.get(id); if (!item) throw new Error('Presentation artifact not found: ' + id); const result = validateArtifactDocument(item.document); return { id, ...result, state: item.state, revisions: item.revisions }; }
  async markStaleByFingerprint(sourceFingerprint) { await this.ready; if (!sourceFingerprint) return { updated: 0 }; let updated = 0; for (const item of this.items.values()) if (item.document.sourceFingerprint && item.document.sourceFingerprint !== sourceFingerprint && item.state === 'current') { item.state = 'stale'; item.updatedAt = new Date().toISOString(); updated++; } if (updated) await this._persist(); return { updated }; }
  async supersede(id) { await this.ready; const item = this.items.get(id); if (!item) throw new Error('Presentation artifact not found: ' + id); item.state = 'superseded'; item.updatedAt = new Date().toISOString(); await this._persist(); return clone(item); }
}
