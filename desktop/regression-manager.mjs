import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { environmentDiff, environmentSnapshot } from './agent-diagnostics.mjs';
import { localHttpRequest } from './local-service-diagnostics.mjs';

async function captureFile(filePath, kind) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Regression source must be a file no larger than 8 MiB');
  const data = await fs.readFile(filePath);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  let details = {};
  if (kind === 'screenshot') {
    if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Screenshot baseline requires a PNG file');
    details = { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  } else {
    const source = data.toString('utf8');
    const tap = source.match(/^\s*(?:not )?ok\b/gm) || [];
    const failures = source.match(/^\s*not ok\b/gm) || [];
    details = { format: /<testsuite\b/i.test(source) ? 'junit' : tap.length ? 'tap' : 'unknown', tests: tap.length || Number(source.match(/\btests="(\d+)"/)?.[1] || 0), failures: failures.length || Number(source.match(/\bfailures="(\d+)"/)?.[1] || 0) };
  }
  return { filePath, bytes: stat.size, sha256, ...details };
}

async function capturePerformance(port, pathname) {
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const { bodyText: _bodyText, ...sample } = await localHttpRequest({ port, pathname });
    samples.push(sample);
  }
  const elapsedMs = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  return { port, pathname, method: 'GET', medianMs: elapsedMs[1], samplesMs: samples.map((item) => item.elapsedMs), status: samples[0].status, bodySha256: samples[0].bodySha256 };
}

export class RegressionManager {
  constructor(dataDir, { captureEnvironment = () => environmentSnapshot() } = {}) { this.directory = path.join(dataDir, 'regressions'); this.captureEnvironment = captureEnvironment; }

  async list() {
    let names;
    try { names = await fs.readdir(this.directory); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of names.filter((item) => /^[0-9a-f-]{36}\.json$/.test(item))) {
      try {
        const item = await this.load(name.slice(0, 36));
        records.push({ id: item.id, kind: item.kind, capturedAt: item.capturedAt });
      } catch {}
    }
    return records.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  }

  async delete(id) {
    await this.load(id);
    await fs.unlink(path.join(this.directory, `${id}.json`));
    return { id, deleted: true };
  }

  async load(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid regression ID');
    try { return JSON.parse(await fs.readFile(path.join(this.directory, `${id}.json`), 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') throw new Error('Regression baseline not found'); throw error; }
  }

  async capture({ kind, port, pathname = '/', filePath }) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = (await fs.readdir(this.directory)).filter((name) => name.endsWith('.json'));
    if (entries.length >= 100) throw new Error('Regression baseline limit reached');
    let value;
    if (kind === 'api') {
      const { bodyText: _bodyText, ...metadata } = await localHttpRequest({ port, pathname });
      value = metadata;
    } else if (kind === 'environment') value = await this.captureEnvironment();
    else if (kind === 'performance') value = await capturePerformance(port, pathname);
    else if (kind === 'test' || kind === 'screenshot') value = await captureFile(filePath, kind);
    else throw new Error('Unsupported regression baseline kind');
    const record = { id: crypto.randomUUID(), kind, capturedAt: new Date().toISOString(), value };
    await fs.writeFile(path.join(this.directory, `${record.id}.json`), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    return { id: record.id, kind, capturedAt: record.capturedAt, value };
  }

  async compareApi(id) {
    const record = await this.load(id);
    if (record.kind !== 'api') throw new Error('Baseline is not an API capture');
    const { bodyText: _bodyText, ...current } = await localHttpRequest({ port: record.value.port, pathname: record.value.pathname });
    const fields = ['status', 'bodySha256', 'truncated', 'jsonShape', 'headers.content-type', 'headers.cache-control', 'headers.etag'];
    const changed = fields.flatMap((field) => {
      const keys = field.split('.');
      const at = (source) => keys.reduce((value, key) => value?.[key], source) ?? null;
      const before = at(record.value);
      const after = at(current);
      if (JSON.stringify(before) === JSON.stringify(after)) return [];
      if (field === 'jsonShape') {
        const beforeNodes = new Map((before?.nodes || []).map((node) => [node.path, node.type]));
        const afterNodes = new Map((after?.nodes || []).map((node) => [node.path, node.type]));
        const paths = [...new Set([...beforeNodes.keys(), ...afterNodes.keys()])].sort().slice(0, 200);
        return paths.flatMap((jsonPath) => beforeNodes.get(jsonPath) === afterNodes.get(jsonPath) ? [] : [{ field: `jsonShape:${jsonPath}`, before: beforeNodes.get(jsonPath) ?? null, after: afterNodes.get(jsonPath) ?? null }]);
      }
      return before === after ? [] : [{ field, before, after }];
    });
    const latency = { baselineMs: record.value.elapsedMs, currentMs: current.elapsedMs, deltaMs: current.elapsedMs - record.value.elapsedMs };
    if (current.elapsedMs > Math.max(record.value.elapsedMs * 1.5, record.value.elapsedMs + 100)) changed.push({ field: 'elapsedMs', before: record.value.elapsedMs, after: current.elapsedMs });
    return { baselineId: id, changed, same: changed.length === 0, latency, current };
  }

  async compareEnvironment(id) {
    const record = await this.load(id);
    if (record.kind !== 'environment') throw new Error('Baseline is not an environment capture');
    const current = await this.captureEnvironment();
    const changes = environmentDiff(record.value, current).changes;
    for (const field of ['runtime', 'tools', 'listeners', 'gpu']) {
      if (JSON.stringify(record.value[field] ?? null) !== JSON.stringify(current[field] ?? null)) changes.push({ name: field, before: record.value[field] ?? null, after: current[field] ?? null });
    }
    return { baselineId: id, changes, same: changes.length === 0 };
  }

  async compare(id) {
    const record = await this.load(id);
    if (record.kind === 'api') return await this.compareApi(id);
    if (record.kind === 'environment') return await this.compareEnvironment(id);
    const current = record.kind === 'performance' ? await capturePerformance(record.value.port, record.value.pathname) : await captureFile(record.value.filePath, record.kind);
    const changed = [];
    for (const field of record.kind === 'performance' ? ['status', 'bodySha256'] : record.kind === 'screenshot' ? ['sha256', 'width', 'height'] : ['sha256', 'tests', 'failures']) {
      if (record.value[field] !== current[field]) changed.push({ field, before: record.value[field], after: current[field] });
    }
    if (record.kind === 'performance' && current.medianMs > Math.max(record.value.medianMs * 1.5, record.value.medianMs + 100)) changed.push({ field: 'medianMs', before: record.value.medianMs, after: current.medianMs });
    return { baselineId: id, kind: record.kind, same: changed.length === 0, changed, current };
  }
}
