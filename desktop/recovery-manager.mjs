import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { buildTransactionEditSummary } from './code-change-review.mjs';

const MAX_FILES = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_TRANSACTIONS = 32;
const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;

function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function same(left, right) {
  return left.exists === right.exists && (!left.exists || left.sha256 === right.sha256);
}

async function transactionEditSummary(record) {
  try {
    return await buildTransactionEditSummary(record);
  } catch {
    return {
      exact: false,
      fileCount: record.paths.length,
      addedLines: null,
      removedLines: null,
      label: 'Editing counts unavailable',
      source: 'transaction_snapshots',
      reason: 'exact_counts_unavailable',
    };
  }
}

function summary(record) {
  return {
    id: record.id, kind: record.kind, workspace: record.workspace,
    status: record.status, createdAt: record.createdAt,
    updatedAt: record.updatedAt, filesCount: record.paths.length,
    paths: [...record.paths],
  };
}

export class RecoveryManager {
  constructor({ dataDir, resolveRead, resolveWrite, authorizeWrite = async () => {}, assertUnlocked = () => {}, withLease = async (_paths, _owner, action) => await action() }) {
    this.directory = path.join(dataDir, 'recovery');
    this.resolveRead = resolveRead;
    this.resolveWrite = resolveWrite;
    this.authorizeWrite = authorizeWrite;
    this.assertUnlocked = assertUnlocked;
    this.withLease = withLease;
    this.transactions = new Map();
  }

  async store(record) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = path.join(this.directory, `${record.id}.json.gz`);
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    const data = gzipSync(Buffer.from(JSON.stringify(record)));
    let occupied = 0;
    for (const name of await fs.readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json\.gz$/.test(name) || name === `${record.id}.json.gz`) continue;
      occupied += (await fs.stat(path.join(this.directory, name))).size;
    }
    if (occupied + data.length > MAX_JOURNAL_BYTES) throw new Error('Recovery storage exceeds its 256 MiB limit; delete unneeded checkpoints');
    try {
      await fs.writeFile(temporary, data, { mode: 0o600 });
      await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async load(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid checkpoint or operation ID');
    try {
      const raw = await fs.readFile(path.join(this.directory, `${id}.json.gz`));
      return JSON.parse(gunzipSync(raw).toString('utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('Checkpoint or operation not found');
      throw error;
    }
  }

  async list(kind) {
    let filenames;
    try { filenames = await fs.readdir(this.directory); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of filenames.filter((item) => /^[0-9a-f-]{36}\.json\.gz$/.test(item))) {
      try {
        const record = await this.load(name.slice(0, 36));
        if (record.kind === kind) records.push(summary(record));
      } catch {}
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async readFileState(target) {
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) { if (error?.code === 'ENOENT') return { exists: false }; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Only regular files can be checkpointed: ${target}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds the 5 MiB checkpoint limit: ${target}`);
    const data = await fs.readFile(target);
    return { exists: true, data: data.toString('base64'), sha256: hash(data), mode: stat.mode & 0o777 };
  }

  async resolve(input, write = false) {
    return await (write ? this.resolveWrite(input) : this.resolveRead(input));
  }

  async capturePaths(inputs, write = false) {
    const paths = new Set();
    let visited = 0;
    const visit = async (input) => {
      if (++visited > 5000) throw new Error('Checkpoint selection exceeds 5,000 entries');
      const lexical = await fs.lstat(input);
      if (lexical.isSymbolicLink()) throw new Error(`Symbolic links cannot be checkpointed: ${input}`);
      const target = await this.resolve(input, write);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links cannot be checkpointed: ${target}`);
      if (stat.isDirectory()) {
        for (const name of await fs.readdir(target)) await visit(path.join(target, name));
      } else if (stat.isFile()) paths.add(target);
      else throw new Error(`Unsupported checkpoint entry: ${target}`);
      if (paths.size > MAX_FILES) throw new Error(`Checkpoint exceeds ${MAX_FILES} files`);
    };
    for (const input of inputs) await visit(input);
    return [...paths].sort();
  }

  async capture(paths) {
    const states = {};
    let totalBytes = 0;
    for (const target of paths) {
      states[target] = await this.readFileState(target);
      totalBytes += states[target].exists ? Buffer.byteLength(states[target].data, 'base64') : 0;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Checkpoint exceeds the 32 MiB total limit');
    }
    return { states, totalBytes };
  }

  async createSnapshot(inputs, workspace) {
    const id = crypto.randomUUID();
    return await this.withLease(inputs, id, async () => {
      const paths = await this.capturePaths(inputs);
      if (!paths.length) throw new Error('Checkpoint selection contains no regular files');
      const { states, totalBytes } = await this.capture(paths);
      const now = new Date().toISOString();
      const record = { id, kind: 'snapshot', workspace, status: 'saved', createdAt: now, updatedAt: now, paths, states, totalBytes };
      await this.store(record);
      return { ...summary(record), sizeBytes: totalBytes };
    });
  }

  async snapshot(id) {
    const record = await this.load(id);
    if (record.kind !== 'snapshot') throw new Error('Snapshot not found');
    return record;
  }

  async inspectSnapshot(id) {
    const record = await this.snapshot(id);
    return { ...summary(record), sizeBytes: record.totalBytes, files: record.paths.map((target) => ({ path: target, sha256: record.states[target].sha256, bytes: Buffer.byteLength(record.states[target].data, 'base64') })) };
  }

  async compareSnapshot(id) {
    const record = await this.snapshot(id);
    const changes = [];
    for (const target of record.paths) {
      await this.resolve(target);
      const current = await this.readFileState(target);
      if (!same(current, record.states[target])) changes.push({ path: target, status: current.exists ? 'modified' : 'deleted', currentSha256: current.sha256 ?? null, savedSha256: record.states[target].sha256 });
    }
    return { snapshotId: id, changes };
  }

  async writeState(target, state) {
    return await this.writeStateOwned(target, state, null);
  }

  async writeStateOwned(target, state, owner) {
    await this.resolve(target, true);
    this.assertUnlocked(target, owner);
    if (!state.exists) {
      const current = await this.readFileState(target);
      if (current.exists) await fs.unlink(target);
      return;
    }
    const data = Buffer.from(state.data, 'base64');
    if (hash(data) !== state.sha256) throw new Error('Checkpoint data failed integrity validation');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.forgelink-${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, data, { mode: state.mode ?? 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async restoreStates(paths, states, owner = null) {
    for (const target of paths.filter((item) => !states[item].exists)) await this.writeStateOwned(target, states[target], owner);
    for (const target of paths.filter((item) => states[item].exists)) await this.writeStateOwned(target, states[target], owner);
  }

  async restoreSnapshot(id) {
    const record = await this.snapshot(id);
    for (const target of record.paths) await this.resolve(target, true);
    await this.withLease(record.paths, id, async () => await this.restoreStates(record.paths, record.states, id));
    return { snapshotId: id, restoredFiles: record.paths.length };
  }

  async deleteSnapshot(id) {
    await this.snapshot(id);
    await fs.unlink(path.join(this.directory, `${id}.json.gz`));
    return { snapshotId: id, deleted: true };
  }

  async begin(workspace) {
    const active = (await this.list('transaction')).filter((item) => ['open', 'previewed', 'applying', 'applied', 'undoing', 'redoing', 'recovery_needed'].includes(item.status));
    if (active.length >= MAX_TRANSACTIONS) throw new Error('Too many active transactions');
    const now = new Date().toISOString();
    const record = { id: crypto.randomUUID(), kind: 'transaction', workspace, status: 'open', createdAt: now, updatedAt: now, paths: [], operations: [], before: {}, after: {} };
    this.transactions.set(record.id, record);
    await this.store(record);
    return summary(record);
  }

  async recordExternalOperation(workspace, paths, before) {
    if (!path.isAbsolute(workspace) || !Array.isArray(paths) || !paths.length || paths.length > MAX_FILES) throw new TypeError('External operation requires a workspace and 1 to 500 paths');
    const ordered = [...new Set(paths)].sort();
    if (ordered.some((target) => !path.isAbsolute(target) || !before?.[target])) throw new Error('External operation before snapshot is incomplete');
    const { states: after } = await this.capture(ordered);
    const now = new Date().toISOString();
    const record = { id: crypto.randomUUID(), kind: 'transaction', workspace, status: 'committed', external: true, createdAt: now, updatedAt: now, paths: ordered, operations: [], before, after };
    await this.store(record);
    return summary(record);
  }

  async transaction(id) {
    let record = this.transactions.get(id);
    if (!record) record = await this.load(id);
    if (record.kind !== 'transaction') throw new Error('Transaction not found');
    if (['open', 'previewed', 'applying', 'applied', 'undoing', 'redoing', 'recovery_needed'].includes(record.status)) this.transactions.set(id, record);
    return record;
  }

  async preview(id, operations) {
    const record = await this.transaction(id);
    if (!['open', 'previewed'].includes(record.status)) throw new Error('Transaction can no longer be previewed');
    if (!operations.length || operations.length > 50) throw new Error('Provide 1 to 50 operations');
    const paths = new Set();
    const normalized = [];
    for (const op of operations) {
      const item = { ...op };
      item.path = await this.resolve(op.path, true);
      paths.add(item.path);
      if (op.kind === 'move') {
        item.to = await this.resolve(op.to, true);
        paths.add(item.to);
      }
      normalized.push(item);
    }
    if (paths.size > MAX_FILES) throw new Error('Transaction exceeds the file limit');
    const ordered = [...paths].sort();
    const { states: before } = await this.capture(ordered);
    const current = new Map(ordered.map((target) => [target, { ...before[target] }]));
    for (const op of normalized) {
      const existing = current.get(op.path);
      if (op.kind === 'write') {
        if (op.expectedSha256 && existing.sha256 !== op.expectedSha256) throw new Error(`File changed since semantic edit was planned: ${op.path}`);
        const data = Buffer.from(op.content, 'utf8');
        if (data.length > MAX_FILE_BYTES) throw new Error('Write exceeds the 5 MiB file limit');
        current.set(op.path, { exists: true, data: data.toString('base64'), sha256: hash(data), mode: existing.mode ?? 0o600 });
      } else if (op.kind === 'replace') {
        if (!existing.exists) throw new Error(`Replace target does not exist: ${op.path}`);
        const original = Buffer.from(existing.data, 'base64');
        const source = original.toString('utf8');
        if (!Buffer.from(source, 'utf8').equals(original)) throw new Error(`Replace target is not valid UTF-8: ${op.path}`);
        const count = source.split(op.oldText).length - 1;
        if (count !== op.expectedOccurrences) throw new Error(`Expected ${op.expectedOccurrences} occurrences, found ${count}: ${op.path}`);
        const data = Buffer.from(source.split(op.oldText).join(op.newText), 'utf8');
        if (data.length > MAX_FILE_BYTES) throw new Error('Replacement exceeds the 5 MiB file limit');
        current.set(op.path, { exists: true, data: data.toString('base64'), sha256: hash(data), mode: existing.mode });
      } else if (op.kind === 'delete') {
        if (!existing.exists) throw new Error(`Delete target does not exist: ${op.path}`);
        current.set(op.path, { exists: false });
      } else if (op.kind === 'move') {
        if (!existing.exists || current.get(op.to).exists) throw new Error('Move requires an existing source and absent destination');
        current.set(op.to, existing);
        current.set(op.path, { exists: false });
      } else throw new Error(`Unsupported transaction operation: ${op.kind}`);
    }
    let totalBytes = 0;
    const after = Object.fromEntries(current);
    for (const state of Object.values(after)) totalBytes += state.exists ? Buffer.byteLength(state.data, 'base64') : 0;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Transaction exceeds the 32 MiB total limit');
    record.paths = ordered;
    record.operations = normalized;
    record.before = before;
    record.after = after;
    record.status = 'previewed';
    record.updatedAt = new Date().toISOString();
    await this.store(record);
    const editSummary = await transactionEditSummary(record);
    return {
      ...summary(record),
      changes: ordered.filter((target) => !same(before[target], after[target])).map((target) => ({ path: target, beforeSha256: before[target].sha256 ?? null, afterSha256: after[target].sha256 ?? null })),
      editSummary,
      progress: { kind: 'editing', text: editSummary.label, exact: editSummary.exact },
    };
  }

  async assertCurrent(record, expected, owner = null) {
    for (const target of record.paths) {
      await this.resolve(target, true);
      this.assertUnlocked(target, owner);
      if (!same(await this.readFileState(target), expected[target])) throw new Error(`File changed since preview: ${target}`);
    }
  }

  async apply(id) {
    const record = await this.transaction(id);
    if (record.status !== 'previewed') throw new Error('Transaction must be previewed before apply');
    return await this.withLease(record.paths, id, async () => {
      await this.assertCurrent(record, record.before, id);
      await this.authorizeWrite(record.paths, 'transaction_apply');
      record.status = 'applying';
      record.updatedAt = new Date().toISOString();
      await this.store(record);
      try {
        await this.restoreStates(record.paths, record.after, id);
        record.status = 'applied';
      } catch (error) {
        try { await this.restoreStates(record.paths, record.before, id); record.status = 'rolled_back'; }
        catch { record.status = 'recovery_needed'; }
        await this.store(record);
        throw error;
      }
      record.updatedAt = new Date().toISOString();
      await this.store(record);
      const editSummary = await transactionEditSummary(record);
      return {
        ...summary(record),
        editSummary,
        progress: { kind: 'editing', text: editSummary.label, exact: editSummary.exact },
      };
    });
  }

  async reconcileApplied(id) {
    const record = await this.transaction(id);
    if (record.status !== 'applied') throw new Error('Only an applied transaction can be reconciled');
    if (!Array.isArray(record.operations) || !record.operations.length || record.operations.some((op) => op.kind !== 'replace')) {
      throw new Error('Only replace-only applied transactions can be reconciled safely');
    }
    if (record.operations.some((op) => typeof op.newText !== 'string' || !op.newText.length)) {
      throw new Error('Replace reconciliation requires nonempty replacement text');
    }
    return await this.withLease(record.paths, id, async () => {
      const current = {};
      for (const target of record.paths) {
        await this.resolve(target, true);
        this.assertUnlocked(target, id);
        current[target] = await this.readFileState(target);
      }
      const before = structuredClone(current);
      const rewrite = (state, from, to, expected, label) => {
        if (!state?.exists) throw new Error(`Cannot reconcile a missing replace target: ${label}`);
        const raw = Buffer.from(state.data, 'base64');
        const source = raw.toString('utf8');
        if (!Buffer.from(source, 'utf8').equals(raw)) throw new Error(`Cannot reconcile non-UTF-8 content: ${label}`);
        const count = source.split(from).length - 1;
        if (count !== expected) throw new Error(`Cannot reconcile ${label}: expected ${expected} replacement occurrence(s), found ${count}`);
        const data = Buffer.from(source.split(from).join(to), 'utf8');
        return { ...state, data: data.toString('base64'), sha256: hash(data) };
      };
      for (const op of [...record.operations].reverse()) {
        before[op.path] = rewrite(before[op.path], op.newText, op.oldText, op.expectedOccurrences, op.path);
      }
      const replay = structuredClone(before);
      for (const op of record.operations) {
        replay[op.path] = rewrite(replay[op.path], op.oldText, op.newText, op.expectedOccurrences, op.path);
      }
      for (const target of record.paths) {
        if (!same(replay[target], current[target])) throw new Error(`Reconciled transaction does not replay exactly to current state: ${target}`);
      }
      const reconciliation = {
        at: new Date().toISOString(),
        mode: 'replace-only',
        paths: record.paths.map((target) => ({
          path: target,
          previousAfterSha256: record.after[target]?.sha256 ?? null,
          currentSha256: current[target]?.sha256 ?? null,
        })),
      };
      record.reconciliations = Array.isArray(record.reconciliations) ? record.reconciliations : [];
      record.reconciliations.push(reconciliation);
      if (record.reconciliations.length > 10) record.reconciliations.splice(0, record.reconciliations.length - 10);
      record.before = before;
      record.after = current;
      record.updatedAt = reconciliation.at;
      await this.store(record);
      const editSummary = await transactionEditSummary(record);
      return {
        ...summary(record),
        reconciled: true,
        reconciliation,
        editSummary,
        progress: { kind: 'editing', text: editSummary.label, exact: editSummary.exact },
      };
    });
  }

  async commit(id) {
    const record = await this.transaction(id);
    if (record.status !== 'applied') throw new Error('Only an applied transaction can be committed');
    await this.withLease(record.paths, id, async () => {
      await this.assertCurrent(record, record.after, id);
      await this.authorizeWrite(record.paths, 'transaction_commit');
      record.status = 'committed';
      record.updatedAt = new Date().toISOString();
      await this.store(record);
    });
    this.transactions.delete(id);
    return summary(record);
  }

  async rollback(id) {
    const record = await this.transaction(id);
    if (record.status === 'open' || record.status === 'previewed') {
      record.status = 'rolled_back';
    } else if (['applied', 'applying', 'undoing', 'redoing', 'recovery_needed'].includes(record.status)) {
      await this.withLease(record.paths, id, async () => {
        if (record.status === 'applied') await this.assertCurrent(record, record.after, id);
        else {
          for (const target of record.paths) {
            await this.resolve(target, true);
            const current = await this.readFileState(target);
            if (!same(current, record.before[target]) && !same(current, record.after[target])) throw new Error(`File changed outside the interrupted transaction: ${target}`);
          }
        }
        await this.restoreStates(record.paths, record.before, id);
        record.status = 'rolled_back';
      });
    } else throw new Error('Transaction cannot be rolled back in its current state');
    record.updatedAt = new Date().toISOString();
    await this.store(record);
    this.transactions.delete(id);
    return summary(record);
  }

  async status(id) { return summary(await this.transaction(id)); }

  async undo(id) {
    const record = await this.transaction(id);
    if (record.status !== 'committed') throw new Error('Only a committed transaction can be undone');
    await this.withLease(record.paths, id, async () => {
      await this.assertCurrent(record, record.after, id);
      record.status = 'undoing';
      record.updatedAt = new Date().toISOString();
      await this.store(record);
      try { await this.restoreStates(record.paths, record.before, id); }
      catch (error) {
        record.status = 'recovery_needed';
        await this.store(record);
        throw error;
      }
      record.status = 'undone';
      record.updatedAt = new Date().toISOString();
      await this.store(record);
    });
    this.transactions.delete(id);
    return summary(record);
  }

  async redo(id) {
    const record = await this.transaction(id);
    if (record.status !== 'undone') throw new Error('Only an undone transaction can be redone');
    await this.withLease(record.paths, id, async () => {
      await this.assertCurrent(record, record.before, id);
      record.status = 'redoing';
      record.updatedAt = new Date().toISOString();
      await this.store(record);
      try { await this.restoreStates(record.paths, record.after, id); }
      catch (error) {
        record.status = 'recovery_needed';
        await this.store(record);
        throw error;
      }
      record.status = 'committed';
      record.updatedAt = new Date().toISOString();
      await this.store(record);
    });
    this.transactions.delete(id);
    return summary(record);
  }
}
