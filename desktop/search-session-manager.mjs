import crypto from 'node:crypto';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { createDirectoryWalker } from './search-walker.mjs';

const PAGE_SCAN_CAP = 20_000;

export class SearchSessionManager {
  constructor({ resolveDirectory, validateRoot, now = () => Date.now(), ttlMs = 10 * 60_000, maxSessions = 20 } = {}) {
    this.resolveDirectory = resolveDirectory;
    this.validateRoot = validateRoot;
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  sweep() {
    for (const [id, session] of this.sessions) if (this.now() - session.touchedAt > this.ttlMs) { session.walker.cancel(); this.sessions.delete(id); }
  }

  create({ root, pattern, excludePatterns = [], maxDepth = 8, prune = true, prunePatterns, parallelism = 4 } = {}) {
    this.sweep();
    if (this.sessions.size >= this.maxSessions) throw new Error('Search session limit reached; cancel or finish an existing search');
    const id = crypto.randomUUID();
    const walker = createDirectoryWalker(root, { excludePatterns, maxDepth, prune, prunePatterns, parallelism, resolveDirectory: this.resolveDirectory });
    this.sessions.set(id, { id, root, pattern, walker, pending: [], touchedAt: this.now(), controller: null, busy: false, scannedEntriesTotal: 0, lastScan: null });
    return id;
  }

  get(cursor) {
    this.sweep();
    const session = this.sessions.get(cursor);
    if (!session) throw new Error('Search cursor expired or was not found');
    session.touchedAt = this.now();
    return session;
  }

  cancel(cursor) {
    const session = this.get(cursor);
    session.controller?.abort();
    session.walker.cancel();
    this.sessions.delete(cursor);
    return { cursor, cancelled: true };
  }

  async page(cursor, { maxEntries = 20_000, maxResults = 100, maxTimeMs = 3000 } = {}) {
    const session = this.get(cursor);
    if (session.busy) throw new Error('This search cursor is already being scanned');
    if (this.validateRoot) await this.validateRoot(session.root);
    session.busy = true;
    session.controller = new AbortController();
    let scan = session.lastScan;
    let scannedThisPage = 0;
    try {
      if (session.pending.length < maxResults && !scan?.traversalExhausted) {
        scan = await session.walker.nextPage({ maxEntries: Math.min(maxEntries, PAGE_SCAN_CAP), maxTimeMs, signal: session.controller.signal });
        scannedThisPage = scan.scannedEntries;
        session.lastScan = scan;
        session.scannedEntriesTotal += scan.scannedEntries;
        for (const item of scan.items) {
          const options = { dot: true, nocase: true };
          if (minimatch(item.relative, session.pattern, options) || (!session.pattern.includes('/') && minimatch(path.basename(item.relative), session.pattern, options))) session.pending.push(item.full);
        }
      }
      const matches = session.pending.splice(0, maxResults);
      const cancelled = scan?.reason === 'CANCELLED' || session.controller.signal.aborted;
      const exhausted = scan?.traversalExhausted === true;
      const complete = !cancelled && exhausted && (scan?.skippedLocationsCount ?? 0) === 0 && session.pending.length === 0;
      const resumable = !cancelled && (!exhausted || session.pending.length > 0);
      const reason = cancelled ? 'CANCELLED' : complete ? 'SEARCH_COMPLETE' : session.pending.length ? 'RESULT_LIMIT' : exhausted ? 'SKIPPED_LOCATIONS' : scan?.reason || 'SCAN_LIMIT';
      if (!resumable) this.sessions.delete(cursor);
      return { root: session.root, pattern: session.pattern, matches, complete, status: complete ? matches.length ? 'found' : 'not_found' : matches.length ? 'partial_matches' : 'incomplete', reason, nextCursor: resumable ? cursor : null, scannedEntries: scannedThisPage, scannedEntriesTotal: session.scannedEntriesTotal, skippedLocationsCount: scan?.skippedLocationsCount ?? 0, skippedLocations: scan?.skippedLocations ?? [], truncated: !complete, pageScanCap: PAGE_SCAN_CAP };
    } finally { session.busy = false; session.controller = null; }
  }

  async find({ root, pattern, excludePatterns = [], maxDepth = 8, prune = true, parallelism = 4, maxScanEntries = 100_000, maxTimeMs = 10_000, maxResults = 100, signal } = {}) {
    const cursor = this.create({ root, pattern, excludePatterns, maxDepth, prune, parallelism });
    const abort = () => { if (this.sessions.has(cursor)) this.cancel(cursor); };
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = this.now() + maxTimeMs;
    const matches = [];
    let latest;
    let scannedEntries = 0;
    try {
      while (!signal?.aborted && scannedEntries < maxScanEntries && this.now() < deadline && matches.length < maxResults) {
        latest = await this.page(cursor, { maxEntries: Math.min(PAGE_SCAN_CAP, maxScanEntries - scannedEntries), maxResults: maxResults - matches.length, maxTimeMs: Math.max(1, Math.min(3000, deadline - this.now())) });
        matches.push(...latest.matches);
        scannedEntries = latest.scannedEntriesTotal;
        if (!latest.nextCursor) break;
      }
      if (!latest) latest = { root, pattern, matches: [], complete: false, status: 'incomplete', reason: 'TIME_LIMIT', nextCursor: cursor, scannedEntries: 0, scannedEntriesTotal: 0, skippedLocationsCount: 0, skippedLocations: [], truncated: true };
      const complete = latest.complete;
      const reason = complete ? 'SEARCH_COMPLETE' : matches.length >= maxResults ? 'RESULT_LIMIT' : scannedEntries >= maxScanEntries ? 'SCAN_LIMIT' : this.now() >= deadline ? 'TIME_LIMIT' : latest.reason;
      return { ...latest, matches, complete, status: complete ? matches.length ? 'found' : 'not_found' : matches.length ? 'partial_matches' : 'incomplete', reason: signal?.aborted ? 'CANCELLED' : reason, nextCursor: signal?.aborted ? null : latest.nextCursor, scannedEntries: scannedEntries, scannedEntriesTotal: scannedEntries, truncated: !complete };
    } finally { signal?.removeEventListener('abort', abort); }
  }
}
