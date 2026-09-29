import path from "node:path";
import fsp from "node:fs/promises";
import { minimatch } from "minimatch";

const SKIPPABLE_DIRECTORY_ERRORS = new Set([
  "EACCES", "EPERM", "EBUSY", "ENOENT", "ENOTDIR", "ELOOP", "EMFILE", "ENFILE", "ENAMETOOLONG",
]);
const MAX_SKIPPED_EXAMPLES = 50;
const DEFAULT_PRUNED_NAMES = new Set([
  "node_modules", ".git", ".vscode", "dist", "build", "bin", "obj", "__pycache__", ".venv", "venv",
  "$recycle.bin", "system volume information",
]);

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "UNKNOWN";
}

function skipCategory(reason) {
  if (reason === "EACCES" || reason === "EPERM") return "ACCESS_DENIED";
  if (reason === "ENOENT" || reason === "ENOTDIR" || reason === "ELOOP") return "BROKEN_LINK";
  if (reason === "REPARSE_POINT") return "SKIPPED_REPARSE_POINT";
  if (reason === "PRUNED") return "PRUNED_DIRECTORY";
  if (reason === "DEPTH_LIMIT") return "DEPTH_LIMIT";
  return "READ_ERROR";
}

function isOutsideScope(error) {
  return /outside (?:the )?(?:approved|allowed) root/i.test(String(error?.message || ""));
}

function validLimit(value, name, { allowInfinity = false } = {}) {
  if (allowInfinity && value === Infinity) return value;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
  return value;
}

function shouldPrune(relative, name, prune, prunePatterns) {
  if (!prune) return false;
  if (prunePatterns !== undefined) return prunePatterns.some((pattern) => minimatch(relative, pattern, { dot: true, nocase: true }));
  if (DEFAULT_PRUNED_NAMES.has(name.toLowerCase())) return true;
  const parts = relative.toLowerCase().split("/");
  return (parts.length >= 3 && parts.slice(-3).join("/") === "appdata/local/temp")
    || (parts.length >= 2 && parts.slice(-2).join("/") === "windows/winsxs");
}

/**
 * One traversal whose position is retained between pages. The caller owns the
 * opaque cursor ID and must keep this object only while that cursor is valid.
 * Directory entries are held for the active directory, so a page can end in
 * the middle of it without losing or repeating any entries.
 *
 * resolveDirectory must enforce the caller's filesystem scope. The server must
 * recheck that scope before accepting a continuation request.
 */
export function createDirectoryWalker(directory, {
  excludePatterns = [],
  maxDepth = Infinity,
  prune = true,
  prunePatterns,
  parallelism = 1,
  readdir = (target, options) => fsp.readdir(target, options),
  resolveDirectory = async (target) => target,
} = {}) {
  if (typeof directory !== "string" || !directory) throw new TypeError("directory must be a nonempty path");
  validLimit(maxDepth, "maxDepth", { allowInfinity: true });
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 16) {
    throw new RangeError("parallelism must be an integer from 1 to 16");
  }
  if (!Array.isArray(excludePatterns) || excludePatterns.some((pattern) => typeof pattern !== "string")) {
    throw new TypeError("excludePatterns must be an array of strings");
  }
  if (prunePatterns !== undefined && (!Array.isArray(prunePatterns) || prunePatterns.some((pattern) => typeof pattern !== "string"))) {
    throw new TypeError("prunePatterns must be an array of strings");
  }

  const pending = [{ path: directory, depth: 0 }];
  let pendingIndex = 0;
  let active = null;
  let skippedLocationsCount = 0;
  const skippedLocations = [];
  const skippedReasonCounts = {};
  let scannedEntriesTotal = 0;
  let cancelled = false;
  let inProgress = false;

  function noteSkipped(target, reason) {
    skippedLocationsCount += 1;
    const category = skipCategory(reason);
    skippedReasonCounts[category] = (skippedReasonCounts[category] || 0) + 1;
    if (skippedLocations.length < MAX_SKIPPED_EXAMPLES) skippedLocations.push({ path: target, reason });
  }

  function hasRemaining() {
    return (active !== null && active.index < active.entries.length) || pendingIndex < pending.length;
  }

  function prefetchPending() {
    for (let index = pendingIndex; index < Math.min(pending.length, pendingIndex + parallelism); index += 1) {
      const current = pending[index];
      if (!current.readPromise) {
        current.readPromise = Promise.resolve()
          .then(() => readdir(current.path, { withFileTypes: true }))
          .then((entries) => ({ entries }), (error) => ({ error }));
      }
    }
  }

  function result(items, scannedEntries, pageSkippedCount, reason) {
    const exhausted = !hasRemaining();
    const complete = exhausted && !cancelled && skippedLocationsCount === 0;
    const finalReason = cancelled ? "CANCELLED"
      : !exhausted ? reason
        : skippedLocationsCount > 0 ? "SKIPPED_LOCATIONS" : "SEARCH_COMPLETE";
    return {
      items,
      scannedEntries,
      scannedEntriesTotal,
      skippedLocationsCount,
      pageSkippedLocationsCount: pageSkippedCount,
      skippedLocations: [...skippedLocations],
      skippedReasonCounts: { ...skippedReasonCounts },
      complete,
      traversalExhausted: exhausted,
      status: complete ? "complete" : "incomplete",
      reason: finalReason,
      truncated: !exhausted && !cancelled,
      resumable: !exhausted && !cancelled,
    };
  }

  return {
    cancel() { cancelled = true; },
    get cancelled() { return cancelled; },
    get exhausted() { return !hasRemaining(); },
    get scannedEntriesTotal() { return scannedEntriesTotal; },
    async nextPage({ maxEntries = 5000, maxTimeMs = Infinity, signal } = {}) {
      validLimit(maxEntries, "maxEntries");
      validLimit(maxTimeMs, "maxTimeMs", { allowInfinity: true });
      if (inProgress) throw new Error("A directory walker page is already in progress");
      inProgress = true;
      const onAbort = () => { cancelled = true; };
      if (signal?.aborted) cancelled = true;
      else signal?.addEventListener?.("abort", onAbort, { once: true });
      const started = performance.now();
      const items = [];
      let scannedEntries = 0;
      const initialSkippedCount = skippedLocationsCount;
      let stopReason = "SCAN_LIMIT";
      try {
        while (!cancelled && hasRemaining()) {
          if (scannedEntries >= maxEntries) break;
          if (performance.now() - started >= maxTimeMs) { stopReason = "TIME_LIMIT"; break; }
          if (active === null || active.index >= active.entries.length) {
            active = null;
            prefetchPending();
            const current = pending[pendingIndex++];
            if (cancelled) { pendingIndex -= 1; break; }
            let timer;
            let abortListener;
            const remaining = maxTimeMs === Infinity ? Infinity : Math.max(1, maxTimeMs - (performance.now() - started));
            const waiters = [current.readPromise];
            if (Number.isFinite(remaining)) waiters.push(new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), remaining); }));
            if (signal) waiters.push(new Promise((resolve) => { abortListener = () => resolve({ aborted: true }); signal.addEventListener("abort", abortListener, { once: true }); }));
            const read = await Promise.race(waiters);
            clearTimeout(timer);
            if (abortListener) signal.removeEventListener("abort", abortListener);
            if (read.timedOut || read.aborted) {
              pendingIndex -= 1;
              stopReason = read.timedOut ? "TIME_LIMIT" : "CANCELLED";
              break;
            }
            if (pendingIndex > 1024 && pendingIndex * 2 > pending.length) {
              pending.splice(0, pendingIndex);
              pendingIndex = 0;
            }
            const { entries, error } = read;
            if (error) {
              if (!SKIPPABLE_DIRECTORY_ERRORS.has(errorCode(error)) && !isOutsideScope(error)) throw error;
              noteSkipped(current.path, errorCode(error));
              continue;
            }
            if (cancelled) break;
            active = { ...current, entries, index: 0 };
            continue;
          }

          const entry = active.entries[active.index++];
          const full = path.join(active.path, entry.name);
          const relative = path.relative(directory, full).replaceAll("\\", "/");
          if (excludePatterns.some((pattern) => minimatch(relative, pattern, { dot: true }))) continue;

          scannedEntries += 1;
          scannedEntriesTotal += 1;
          const isSymlink = entry.isSymbolicLink?.() === true;
          const isDirectory = entry.isDirectory();
          const excludedDescendants = isDirectory && excludePatterns.some((pattern) =>
            minimatch(`${relative}/__forgelink_child__`, pattern, { dot: true }));
          items.push({ full, relative, isDirectory });

          if (isSymlink) {
            noteSkipped(full, "REPARSE_POINT");
          } else if (isDirectory && active.depth >= maxDepth) {
            noteSkipped(full, "DEPTH_LIMIT");
          } else if (isDirectory && shouldPrune(relative, entry.name, prune, prunePatterns)) {
            noteSkipped(full, "PRUNED");
          } else if (excludedDescendants) {
            // An explicit subtree exclusion is part of the requested scope, not
            // a skipped or incomplete location. Keep the folder's own entry.
          } else if (isDirectory) {
            try {
              const resolved = await resolveDirectory(full);
              if (cancelled) break;
              pending.push({ path: resolved, depth: active.depth + 1 });
            } catch (error) {
              if (!SKIPPABLE_DIRECTORY_ERRORS.has(errorCode(error)) && !isOutsideScope(error)) throw error;
              noteSkipped(full, errorCode(error));
            }
          }
        }
        return result(items, scannedEntries, skippedLocationsCount - initialSkippedCount, stopReason);
      } finally {
        signal?.removeEventListener?.("abort", onAbort);
        inProgress = false;
      }
    },
  };
}

/** One-page compatibility API used by existing callers. */
export async function walkDirectory(directory, {
  maxEntries = 5000,
  maxTimeMs = Infinity,
  prune = false,
  signal,
  ...options
} = {}) {
  const walker = createDirectoryWalker(directory, { ...options, prune });
  return walker.nextPage({ maxEntries, maxTimeMs, signal });
}
