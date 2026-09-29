import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseUnifiedDiff } from './agent-diagnostics.mjs';

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 256 * 1024;

function relativeSnapshotPath(workspace, filename) {
  const relative = path.relative(workspace, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Transaction review path escaped its workspace');
  }
  return relative;
}

function normalizedDiffPath(value) {
  let result = String(value || '').replaceAll('\\', '/').replace(/^\"|\"$/g, '');
  if (result.includes(' => ')) {
    const [before, after] = result.split(' => ');
    result = (after === '/dev/null' ? before : after).replace(/^\{/, '').replace(/\}/g, '');
  }
  return result.replace(/^(?:a\/|b\/)?(?:before|after)\//, '').replace(/^\/dev\/null$/, '');
}

async function materializeState(root, relative, state) {
  if (!state?.exists) return;
  if (typeof state.data !== 'string') throw new Error('Transaction snapshot is missing file content');
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(state.data, 'base64'), { mode: 0o600 });
}

function gitDiff(gitCommand, cwd, flags, outputLimit) {
  return new Promise((resolve, reject) => {
    const args = ['-c', 'core.quotepath=false', '--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--find-renames', ...flags, '--', 'before', 'after'];
    const child = spawn(gitCommand, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let outputBytes = 0;
    let truncated = false;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) { settled = true; reject(new Error('Code review Git diff timed out')); }
    }, 30_000);
    child.stdout.on('data', (chunk) => {
      const remaining = Math.max(0, outputLimit - outputBytes);
      const kept = chunk.subarray(0, remaining);
      if (kept.length) chunks.push(kept);
      outputBytes += kept.length;
      if (kept.length < chunk.length) truncated = true;
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(0, 1200); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0 && code !== 1) return reject(new Error(`Code review Git diff failed (${code})`));
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), truncated });
    });
  });
}

function parseNumstat(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) throw new Error('Code review could not parse an exact file line count');
    return {
      path: normalizedDiffPath(match[3]),
      addedLines: match[1] === '-' ? 0 : Number(match[1]),
      removedLines: match[2] === '-' ? 0 : Number(match[2]),
      binary: match[1] === '-' || match[2] === '-',
    };
  });
}

export async function buildTransactionEditSummary(record, { gitCommand = process.platform === 'win32' ? 'git.exe' : 'git' } = {}) {
  if (!record || !['previewed', 'applied', 'committed', 'undone'].includes(record.status)) {
    throw new Error('Edit summary requires a previewed, applied, committed, or undone transaction');
  }
  if (!path.isAbsolute(record.workspace) || !Array.isArray(record.paths) || !record.before || !record.after) {
    throw new Error('Transaction edit-summary journal is incomplete');
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-edit-summary-'));
  const beforeRoot = path.join(scratch, 'before');
  const afterRoot = path.join(scratch, 'after');
  try {
    await Promise.all([fs.mkdir(beforeRoot), fs.mkdir(afterRoot)]);
    for (const filename of record.paths) {
      const relative = relativeSnapshotPath(record.workspace, filename);
      await materializeState(beforeRoot, relative, record.before[filename]);
      await materializeState(afterRoot, relative, record.after[filename]);
    }
    const summary = await gitDiff(gitCommand, scratch, ['--numstat'], MAX_SUMMARY_BYTES);
    if (summary.truncated) throw new Error('Edit summary exceeded its safety bound; exact counts are unavailable');
    const counts = parseNumstat(summary.stdout);
    const fileCount = counts.length;
    const addedLines = counts.reduce((sum, file) => sum + file.addedLines, 0);
    const removedLines = counts.reduce((sum, file) => sum + file.removedLines, 0);
    return {
      exact: true,
      fileCount,
      addedLines,
      removedLines,
      label: `Editing +${addedLines} -${removedLines} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`,
      source: 'transaction_snapshots',
    };
  } finally {
    const tempRoot = path.resolve(os.tmpdir());
    const scratchPath = path.resolve(scratch);
    if (scratchPath.startsWith(`${tempRoot}${path.sep}`) && path.basename(scratchPath).startsWith('forgelink-edit-summary-')) {
      await fs.rm(scratchPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function buildCodeChangeReview(record, { gitCommand = process.platform === 'win32' ? 'git.exe' : 'git' } = {}) {
  if (!record || !['committed', 'undone'].includes(record.status)) {
    throw new Error('Final code review requires a committed or undone transaction');
  }
  if (!path.isAbsolute(record.workspace) || !Array.isArray(record.paths) || !record.before || !record.after) {
    throw new Error('Transaction review journal is incomplete');
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-code-review-'));
  const beforeRoot = path.join(scratch, 'before');
  const afterRoot = path.join(scratch, 'after');
  try {
    await Promise.all([fs.mkdir(beforeRoot), fs.mkdir(afterRoot)]);
    for (const filename of record.paths) {
      const relative = relativeSnapshotPath(record.workspace, filename);
      await materializeState(beforeRoot, relative, record.before[filename]);
      await materializeState(afterRoot, relative, record.after[filename]);
    }
    const summary = await gitDiff(gitCommand, scratch, ['--numstat'], MAX_SUMMARY_BYTES);
    if (summary.truncated) throw new Error('Code review summary exceeded its safety bound; exact counts are unavailable');
    const counts = parseNumstat(summary.stdout);
    const preview = await gitDiff(gitCommand, scratch, ['--unified=5'], MAX_PREVIEW_BYTES);
    const parsed = parseUnifiedDiff(preview.stdout);
    const byPath = new Map(parsed.files.map((file) => [normalizedDiffPath(file.path), file]));
    const files = counts.map((count, index) => {
      const detail = byPath.get(count.path) || parsed.files[index] || {};
      return {
        ...detail,
        path: count.path,
        renamedFrom: detail.renamedFrom ? normalizedDiffPath(detail.renamedFrom) : null,
        status: detail.status || 'modified',
        hunks: detail.hunks || [],
        addedLines: count.addedLines,
        removedLines: count.removedLines,
        binary: count.binary || Boolean(detail.binary),
      };
    });
    return {
      operationId: record.id,
      workspace: record.workspace,
      status: record.status,
      files,
      fileCount: files.length,
      addedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
      removedLines: files.reduce((sum, file) => sum + file.removedLines, 0),
      truncated: preview.truncated || parsed.truncated,
      undoAvailable: record.status === 'committed',
      redoAvailable: record.status === 'undone',
      source: 'transaction_snapshots',
      reviewId: crypto.createHash('sha256').update(`${record.id}:${record.status}:${files.map((file) => `${file.path}:${file.addedLines}:${file.removedLines}`).join('|')}`).digest('hex').slice(0, 16),
    };
  } finally {
    const tempRoot = path.resolve(os.tmpdir());
    const scratchPath = path.resolve(scratch);
    if (scratchPath.startsWith(`${tempRoot}${path.sep}`) && path.basename(scratchPath).startsWith('forgelink-code-review-')) {
      await fs.rm(scratchPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function combineWorkflowCodeReviews(protocolId, reviews) {
  if (typeof protocolId !== 'string' || !protocolId || !Array.isArray(reviews) || !reviews.length) {
    throw new Error('A workflow and its committed operation reviews are required');
  }
  const workspace = reviews[0].workspace;
  if (reviews.some((review) => review.status !== 'committed' || review.workspace !== workspace || !Array.isArray(review.files) || !review.operationId || !review.reviewId)) {
    throw new Error('Workflow review requires committed operations from one workspace');
  }
  const files = new Map();
  let previewBytes = 0;
  let truncated = reviews.some((review) => review.truncated);
  for (const [index, review] of reviews.entries()) {
    for (const file of review.files) {
      const existing = files.get(file.path);
      const combined = existing || { ...file, hunks: [], addedLines: 0, removedLines: 0 };
      if (existing) combined.status = 'modified';
      combined.addedLines += file.addedLines;
      combined.removedLines += file.removedLines;
      combined.binary = Boolean(combined.binary || file.binary);
      for (const hunk of file.hunks || []) {
        const labelled = { ...hunk, header: `Operation ${index + 1}: ${hunk.header || ''}` };
        const bytes = Buffer.byteLength(JSON.stringify(labelled));
        if (previewBytes + bytes > MAX_PREVIEW_BYTES) { truncated = true; continue; }
        previewBytes += bytes;
        combined.hunks.push(labelled);
      }
      files.set(file.path, combined);
    }
  }
  const operationReviews = reviews.map(({ operationId, reviewId }) => ({ operationId, reviewId }));
  return {
    protocolId,
    workspace,
    status: 'committed',
    files: [...files.values()],
    fileCount: files.size,
    operationCount: reviews.length,
    operationReviews,
    addedLines: reviews.reduce((sum, review) => sum + review.addedLines, 0),
    removedLines: reviews.reduce((sum, review) => sum + review.removedLines, 0),
    truncated,
    undoAvailable: false,
    redoAvailable: false,
    source: 'workflow_transaction_snapshots',
    reviewId: crypto.createHash('sha256').update(JSON.stringify({ protocolId, operationReviews })).digest('hex').slice(0, 16),
  };
}
