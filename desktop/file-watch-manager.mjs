import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';

const MAX_WATCHES = 16;
const MAX_PENDING = 2000;
const MAX_KNOWN = 20000;
const RENAME_WINDOW_MS = 300;
const DEFAULT_EXCLUDES = ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**'];

function identity(stat) {
  return stat?.ino ? `${stat.dev}:${stat.ino}` : null;
}

function matchesPatterns(relativePath, includePatterns, excludePatterns) {
  const candidate = relativePath.replaceAll('\\', '/');
  const options = { dot: true, matchBase: true };
  return (includePatterns.length === 0 || includePatterns.some((pattern) => minimatch(candidate, pattern, options)))
    && !excludePatterns.some((pattern) => minimatch(candidate, pattern, options));
}

export class FileWatchManager {
  constructor({ publish, validatePath = async (candidate) => candidate, maxWatches = MAX_WATCHES } = {}) {
    this.publish = publish;
    this.validatePath = validatePath;
    this.maxWatches = maxWatches;
    this.watches = new Map();
  }

  summary(watch) {
    return {
      watchId: watch.id,
      path: watch.root,
      recursive: watch.recursive,
      includePatterns: [...watch.includePatterns],
      excludePatterns: [...watch.excludePatterns],
      status: watch.status,
      createdAt: watch.createdAt,
      eventsObserved: watch.eventsObserved,
      pending: watch.pending.size,
    };
  }

  create({ root, recursive = true, includePatterns = [], excludePatterns = DEFAULT_EXCLUDES }) {
    if (this.watches.size >= this.maxWatches) throw new Error(`At most ${this.maxWatches} file watches may be active`);
    const native = fs.watch(root, { recursive, persistent: false }, (changeKind, filename) => {
      this.onFsEvent(watch, changeKind, filename);
    });
    const watch = {
      id: crypto.randomUUID(), root, recursive,
      includePatterns: [...includePatterns], excludePatterns: [...excludePatterns],
      native, status: 'active', createdAt: new Date().toISOString(),
      eventsObserved: 0, pending: new Map(), known: new Map(),
      tombstones: new Map(), suppressed: new Map(),
    };
    this.watches.set(watch.id, watch);
    native.on('error', () => {
      if (watch.status === 'stopped') return;
      watch.status = 'error';
      this.publish({ type: 'watch.error', path: root, watchId: watch.id });
      this.stop(watch.id);
    });
    this.publish({ type: 'watch.started', path: root, watchId: watch.id });
    return this.summary(watch);
  }

  onFsEvent(watch, changeKind, filename) {
    if (watch.status !== 'active') return;
    if (!filename) {
      this.publish({ type: 'watch.unknown', path: watch.root, watchId: watch.id, changeKind });
      return;
    }
    const target = path.resolve(watch.root, String(filename));
    const relative = path.relative(watch.root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    if (!matchesPatterns(relative, watch.includePatterns, watch.excludePatterns)) return;
    if (watch.pending.size >= MAX_PENDING && !watch.pending.has(target)) {
      this.publish({ type: 'watch.overflow', path: watch.root, watchId: watch.id });
      return;
    }
    const previous = watch.pending.get(target);
    if (previous) clearTimeout(previous.timer);
    const pendingKind = previous?.changeKind === 'rename' ? 'rename' : changeKind;
    const timer = setTimeout(() => {
      watch.pending.delete(target);
      void this.flush(watch, target, pendingKind).catch(() => {});
    }, 75);
    timer.unref?.();
    watch.pending.set(target, { timer, changeKind: pendingKind });
  }

  async flush(watch, target, changeKind) {
    if (watch.status !== 'active') return;
    try { await this.validatePath(target); } catch { return; }
    let stat;
    try { stat = await fsp.lstat(target); }
    catch (error) { if (error?.code !== 'ENOENT') return; }
    if (watch.status !== 'active') return;
    const before = watch.known.get(target);
    if (!stat && watch.suppressed.has(target)) {
      clearTimeout(watch.suppressed.get(target));
      watch.suppressed.delete(target);
      return;
    }
    const statIdentity = identity(stat);
    if (stat && changeKind === 'rename' && !before && statIdentity) {
      let previousPath;
      const tombstone = watch.tombstones.get(statIdentity);
      if (tombstone) {
        clearTimeout(tombstone.timer);
        watch.tombstones.delete(statIdentity);
        previousPath = tombstone.path;
      } else {
        for (const [knownPath, metadata] of watch.known) {
          if (knownPath !== target && identity(metadata) === statIdentity) {
            try { await fsp.lstat(knownPath); } catch (error) {
              if (error?.code === 'ENOENT') previousPath = knownPath;
            }
            if (previousPath) break;
          }
        }
      }
      if (watch.status !== 'active') return;
      if (previousPath) {
        watch.known.delete(previousPath);
        const timer = setTimeout(() => watch.suppressed.delete(previousPath), RENAME_WINDOW_MS);
        timer.unref?.();
        watch.suppressed.set(previousPath, timer);
        watch.known.set(target, { mode: stat.mode, dev: stat.dev, ino: stat.ino });
        this.emitFile(watch, path.dirname(previousPath) === path.dirname(target) ? 'file.renamed' : 'file.moved', target, changeKind, previousPath);
        return;
      }
    }
    let type;
    if (!stat) {
      watch.known.delete(target);
      const oldIdentity = identity(before);
      if (oldIdentity && changeKind === 'rename') {
        const prior = watch.tombstones.get(oldIdentity);
        if (prior) clearTimeout(prior.timer);
        const timer = setTimeout(() => {
          watch.tombstones.delete(oldIdentity);
          if (watch.status === 'active') this.emitFile(watch, 'file.deleted', target, changeKind);
        }, RENAME_WINDOW_MS);
        timer.unref?.();
        watch.tombstones.set(oldIdentity, { path: target, timer });
        return;
      }
      type = 'file.deleted';
    } else if (before && before.mode !== stat.mode) {
      type = 'file.permission_changed';
    } else if (changeKind === 'rename' && !before) {
      type = 'file.created';
    } else {
      type = 'file.modified';
    }
    if (stat) {
      watch.known.delete(target);
      watch.known.set(target, { mode: stat.mode, dev: stat.dev, ino: stat.ino });
      if (watch.known.size > MAX_KNOWN) watch.known.delete(watch.known.keys().next().value);
    }
    this.emitFile(watch, type, target, changeKind);
  }

  emitFile(watch, type, target, changeKind, fromPath) {
    watch.eventsObserved += 1;
    this.publish({ type, path: target, ...(fromPath ? { fromPath } : {}), watchId: watch.id, changeKind });
  }

  clearPending(watch) {
    for (const pending of watch.pending.values()) clearTimeout(pending.timer);
    for (const tombstone of watch.tombstones.values()) clearTimeout(tombstone.timer);
    for (const timer of watch.suppressed.values()) clearTimeout(timer);
    watch.pending.clear();
    watch.tombstones.clear();
    watch.suppressed.clear();
  }

  get(id) {
    const watch = this.watches.get(id);
    if (!watch) throw new Error('File watch not found in this backend generation');
    return watch;
  }

  list() {
    return [...this.watches.values()].map((watch) => this.summary(watch));
  }

  pause(id) {
    const watch = this.get(id);
    if (watch.status === 'active') {
      watch.status = 'paused';
      this.clearPending(watch);
      this.publish({ type: 'watch.paused', path: watch.root, watchId: id });
    }
    return this.summary(watch);
  }

  resume(id) {
    const watch = this.get(id);
    if (watch.status === 'paused') {
      watch.status = 'active';
      this.publish({ type: 'watch.resumed', path: watch.root, watchId: id });
    }
    return this.summary(watch);
  }

  stop(id) {
    const watch = this.get(id);
    watch.status = 'stopped';
    this.clearPending(watch);
    watch.native.close();
    this.watches.delete(id);
    this.publish({ type: 'watch.stopped', path: watch.root, watchId: id });
    return this.summary(watch);
  }

  stopAll() {
    for (const watch of this.watches.values()) this.stop(watch.id);
  }

  stopWhere(predicate) {
    for (const watch of this.watches.values()) if (predicate(this.summary(watch))) this.stop(watch.id);
  }
}
