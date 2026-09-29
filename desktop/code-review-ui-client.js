import { App } from '@modelcontextprotocol/ext-apps';
import { createViewerBridge } from './viewer-bridge.js';

const root = document.getElementById('root');
let review = null;
let filesExpanded = false;
let fileDetailFallback = false;
let selectedFile = 0;
let pendingAction = '';
let actionError = '';
let displayMode = 'inline';
let connected = false;
let bridgeFailure = '';
let resizeFrame = 0;
let finalReviewReady = false;
let presentationError = '';
let presentationPending = false;
const acknowledgedReviews = new Set();

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const iconPaths = {
  changes: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12h8M12 8v8"/>',
  undo: '<path d="M9 7 5 11l4 4"/><path d="M5 11h8a6 6 0 0 1 6 6"/>',
  redo: '<path d="m15 7 4 4-4 4"/><path d="M19 11h-8a6 6 0 0 0-6 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  previous: '<path d="m14 6-6 6 6 6"/>',
  next: '<path d="m10 6 6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  open: '<path d="M14 5h5v5"/><path d="M10 14 19 5"/><path d="M19 13v6H5V5h6"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name]}</svg>`;

function payloadOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const part of result?.content || []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    try { return JSON.parse(part.text); } catch {}
  }
  return null;
}

function lineCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
const stats = (added, removed) => `<span class="stats"><span class="plus">+${lineCount(added)}</span><span class="minus">-${lineCount(removed)}</span></span>`;
const fileStats = (file) => file.binary ? '<span class="stats binary-stat">Binary</span>' : stats(file.addedLines, file.removedLines);

function reportSize() {
  if (!connected || displayMode === 'fullscreen') return;
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      const height = Math.max(1, Math.ceil((root.querySelector('.review-card') || root).getBoundingClientRect().height));
      void app.sendSizeChanged({ height }).catch(() => {});
    });
  });
}

function highlightedCode(value, filename) {
  const raw = String(value || '');
  if (!/\.(?:[cm]?[jt]sx?|json|css|py|rs|go)$/i.test(filename || '')) return esc(raw);
  const token = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|#.*$|\b(?:async|await|break|case|catch|class|const|continue|def|else|export|false|finally|for|from|function|if|import|interface|let|new|null|return|static|super|switch|this|throw|true|try|type|var|while|yield)\b|\b\d+(?:\.\d+)?\b)/gm;
  let result = '';
  let cursor = 0;
  for (const match of raw.matchAll(token)) {
    result += esc(raw.slice(cursor, match.index));
    const part = match[0];
    const kind = /^(?:["'`])/.test(part) ? 'string' : /^(?:\/\/|#)/.test(part) ? 'comment' : /^\d/.test(part) ? 'number' : 'keyword';
    result += `<span class="syntax-${kind}">${esc(part)}</span>`;
    cursor = match.index + part.length;
  }
  return result + esc(raw.slice(cursor));
}

function renderDiffLine(line, filename) {
  const tone = line.type === 'add' ? 'add' : line.type === 'remove' ? 'remove' : 'context';
  const marker = tone === 'add' ? '+' : tone === 'remove' ? '-' : ' ';
  return `<div class="diff-line ${tone}"><span class="line-number">${esc(line.oldLine ?? '')}</span><span class="line-number">${esc(line.newLine ?? '')}</span><span class="line-code"><span class="line-marker">${marker}</span>${highlightedCode(line.text, filename)}</span></div>`;
}

function renderDiff(file) {
  const hunks = Array.isArray(file.hunks) ? file.hunks : [];
  let body;
  if (file.binary) body = '<div class="diff-note">Binary file changed. A line-by-line preview is unavailable.</div>';
  else if (!hunks.length) body = '<div class="diff-note">No text preview is available for this file.</div>';
  else body = hunks.map((hunk) => `<div class="hunk"><div class="hunk-heading">${esc(hunk.header)}</div>${(hunk.lines || []).map((line) => renderDiffLine(line, file.path)).join('')}${hunk.truncated ? '<div class="diff-note">This hunk preview is shortened. The counts above include the full file.</div>' : ''}</div>`).join('');
  const status = file.status === 'added' ? '<span class="status-badge">New</span>' : file.status === 'deleted' ? '<span class="status-badge deleted">Deleted</span>' : file.status === 'renamed' ? '<span class="status-badge">Renamed</span>' : '';
  return `<div class="diff-file-header"><span class="diff-path" title="${esc(file.path)}">${esc(file.path)}${status}</span>${fileStats(file)}</div><div class="diff-scroller">${body}</div>`;
}

async function runHistoryAction(kind) {
  const available = kind === 'undo' ? review?.undoAvailable : review?.redoAvailable;
  if (!available || !review?.operationId || pendingAction) return;
  pendingAction = kind;
  actionError = '';
  render();
  try {
    const result = await app.callServerTool({ name: `code_review_${kind}`, arguments: { operationId: review.operationId } });
    if (result?.isError) throw new Error(`${kind === 'undo' ? 'Undo' : 'Redo'} was rejected. The files may have changed since this review.`);
    const response = payloadOf(result);
    const status = response?.status || (kind === 'undo' ? 'undone' : 'committed');
    review = { ...review, status, undoAvailable: status === 'committed', redoAvailable: status === 'undone' };
    if (kind === 'undo') acknowledgedReviews.delete(`${review.operationId}:${review.reviewId}`);
  } catch (error) {
    actionError = String(error?.message || error || 'Operation failed');
  } finally {
    pendingAction = '';
    render();
  }
}

async function openFileReview(index) {
  if (!review?.files?.length) return;
  selectedFile = Math.min(Math.max(0, Number(index) || 0), review.files.length - 1);
  fileDetailFallback = false;
  try {
    const context = app.getHostContext?.();
    if (Array.isArray(context?.availableDisplayModes) && !context.availableDisplayModes.includes('fullscreen')) {
      fileDetailFallback = true;
      render();
      return;
    }
    const result = await app.requestDisplayMode({ mode: 'fullscreen' });
    if (result?.mode === 'fullscreen') {
      displayMode = 'fullscreen';
      document.documentElement.dataset.displayMode = displayMode;
      render();
      return;
    }
  } catch (error) {
    console.warn('Focused file review unavailable; using inline file-only fallback', error);
  }
  fileDetailFallback = true;
  render();
}

async function closeFileReview() {
  fileDetailFallback = false;
  if (displayMode === 'fullscreen') {
    try {
      const result = await app.requestDisplayMode({ mode: 'inline' });
      displayMode = result?.mode || 'inline';
    } catch {
      displayMode = 'inline';
    }
    document.documentElement.dataset.displayMode = displayMode;
  }
  render();
}

function renderFocusedFile(files) {
  selectedFile = Math.min(selectedFile, Math.max(0, files.length - 1));
  const file = files[selectedFile];
  return `<section class="details focused-details" aria-label="File changes"><div class="details-toolbar"><div><span class="eyebrow">FILE REVIEW</span><strong title="${esc(file.path)}">${esc(file.path)}</strong></div><div class="detail-actions"><span class="file-position">${selectedFile + 1} of ${files.length}</span><button id="previous-file" class="icon-button" type="button" aria-label="Previous file" ${selectedFile === 0 ? 'disabled' : ''}>${icon('previous')}</button><button id="next-file" class="icon-button" type="button" aria-label="Next file" ${selectedFile === files.length - 1 ? 'disabled' : ''}>${icon('next')}</button><button id="close-review" class="icon-button" type="button" aria-label="Close file review">${icon('close')}</button></div></div>${renderDiff(file)}${review.truncated ? '<div class="diff-note">The diff preview reached its size limit. File counts remain exact.</div>' : ''}${presentationError ? `<div class="error-note" role="alert">${esc(presentationError)} <button id="presentation-retry" type="button">Retry confirmation</button></div>` : ''}</section>`;
}

function render() {
  if (!review || !Array.isArray(review.files)) {
    root.innerHTML = `<div class="empty">${icon('changes')}<div><strong>Code review</strong><span>${bridgeFailure ? esc(bridgeFailure) : 'Waiting for the workflow changes…'}</span>${bridgeFailure ? '<button id="bridge-retry" type="button">Retry connection</button>' : ''}</div></div>`;
    root.querySelector('#bridge-retry')?.addEventListener('click', () => { bridgeFailure = ''; render(); void bridge.connect(); });
    reportSize();
    return;
  }
  const files = review.files;
  selectedFile = Math.min(selectedFile, Math.max(0, files.length - 1));
  if ((displayMode === 'fullscreen' || fileDetailFallback) && files.length) {
    root.innerHTML = renderFocusedFile(files);
    root.querySelector('#previous-file')?.addEventListener('click', () => { selectedFile = Math.max(0, selectedFile - 1); render(); });
    root.querySelector('#next-file')?.addEventListener('click', () => { selectedFile = Math.min(files.length - 1, selectedFile + 1); render(); });
    root.querySelector('#close-review')?.addEventListener('click', () => void closeFileReview());
    root.querySelector('#presentation-retry')?.addEventListener('click', () => { presentationError = ''; render(); });
    reportSize();
    return;
  }
  const visible = filesExpanded ? files : files.slice(0, 3);
  const remaining = files.length - visible.length;
  const rows = visible.map((file, index) => `<button class="file-row" type="button" data-file="${index}" aria-label="Open ${esc(file.path)} changes, ${file.binary ? 'binary file' : `${lineCount(file.addedLines)} lines added, ${lineCount(file.removedLines)} lines removed`}"><span class="file-path" title="${esc(file.path)}">${esc(file.path)}</span>${fileStats(file)}</button>`).join('');
  const showMore = files.length > 3 ? `<button id="files-toggle" class="files-toggle" type="button" aria-expanded="${filesExpanded}" aria-controls="file-list">${filesExpanded ? 'Collapse files' : `Show ${remaining} more ${remaining === 1 ? 'file' : 'files'}`}${icon('chevron')}</button>` : '';
  const historyKind = review.redoAvailable ? 'redo' : 'undo';
  const historyAvailable = historyKind === 'redo' ? review.redoAvailable : review.undoAvailable;
  const historyLabel = pendingAction === historyKind ? `${historyKind === 'undo' ? 'Undoing' : 'Redoing'}…` : historyKind === 'redo' ? 'Redo' : review.status === 'undone' ? 'Undone' : 'Undo';
  const operationLabel = review.protocolId && review.operationCount > 1 ? ` across ${review.operationCount} operations` : '';
  const historyButton = review.protocolId ? '' : `<button id="history" class="history-action" type="button" ${!historyAvailable || pendingAction ? 'disabled' : ''}>${historyLabel} ${icon(historyKind)}</button>`;
  root.innerHTML = `<article class="review-card"><header class="review-header"><div class="heading"><span class="change-icon">${icon('changes')}</span><div class="heading-copy"><h2>Edited ${files.length} ${files.length === 1 ? 'file' : 'files'}${operationLabel}${review.status === 'undone' ? '<span class="undone-badge">Undone</span>' : ''}</h2><div class="summary-row">${filesExpanded ? stats(review.addedLines, review.removedLines) : '<button id="review-link" class="review-link" type="button">Review changes <span aria-hidden="true">↗</span></button>'}</div></div></div><div class="actions">${historyButton}<button id="review" class="review-action" type="button" ${files.length ? '' : 'disabled'}>Review</button></div></header><div id="file-list" class="files">${rows || '<div class="no-files">No file changes in this workflow.</div>'}</div>${showMore}${actionError ? `<div class="error-note" role="alert">${esc(actionError)}</div>` : ''}${presentationError ? `<div class="error-note" role="alert">${esc(presentationError)} <button id="presentation-retry" type="button">Retry confirmation</button></div>` : ''}</article>`;
  root.querySelector('#presentation-retry')?.addEventListener('click', () => { presentationError = ''; render(); });
  root.querySelector('#files-toggle')?.addEventListener('click', () => { filesExpanded = !filesExpanded; render(); });
  root.querySelector('#review-link')?.addEventListener('click', () => void openFileReview(selectedFile));
  for (const button of root.querySelectorAll('[data-file]')) button.addEventListener('click', () => void openFileReview(Number(button.dataset.file)));
  root.querySelector('#review')?.addEventListener('click', () => void openFileReview(selectedFile));
  root.querySelector('#history')?.addEventListener('click', () => void runHistoryAction(historyKind));
  reportSize();
  void acknowledgePresentation();
}

async function acknowledgePresentation() {
  if (!connected || !finalReviewReady || !(review?.protocolId || review?.operationId) || !review?.reviewId || presentationPending || presentationError) return;
  const key = `${review.protocolId || review.operationId}:${review.reviewId}`;
  if (acknowledgedReviews.has(key)) return;
  presentationPending = true;
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!connected || !root.querySelector('.review-card, .focused-details') || `${review?.protocolId || review?.operationId}:${review?.reviewId}` !== key) return;
    const result = await app.callServerTool({ name: 'code_review_presented', arguments: review.protocolId ? { protocolId: review.protocolId, reviewId: review.reviewId } : { operationId: review.operationId, reviewId: review.reviewId } });
    if (result?.isError) throw new Error('ForgeLink did not confirm this final review.');
    acknowledgedReviews.add(key);
  } catch {
    presentationError = 'Final review is visible, but ForgeLink has not confirmed it for workflow completion.';
    render();
  } finally {
    presentationPending = false;
  }
}

function applyHostContext(context) {
  if (!context) return;
  if (context.theme) document.documentElement.dataset.theme = context.theme;
  if (context.displayMode) {
    displayMode = context.displayMode;
    document.documentElement.dataset.displayMode = displayMode;
    if (displayMode === 'fullscreen') fileDetailFallback = false;
  }
  for (const [key, value] of Object.entries(context.styles?.variables || {})) {
    if (typeof value === 'string' && key.startsWith('--')) document.documentElement.style.setProperty(key, value);
  }
  render();
}

let app;
const bridge = createViewerBridge({
  createApp() {
    const instance = new App(
      { name: 'forgelink-operation-review', version: '4.0.0' },
      { availableDisplayModes: ['inline', 'fullscreen'] },
      { autoResize: false, strict: false },
    );
    app = instance;
    instance.ontoolresult = (params) => { if (app === instance) acceptReview(params?.structuredContent || payloadOf(params)); };
    instance.onhostcontextchanged = (params) => { if (app === instance) applyHostContext(params); };
    return instance;
  },
  onConnected(instance) {
    connected = true;
    bridgeFailure = '';
    presentationError = '';
    applyHostContext(instance.getHostContext());
    if (!review && window.openai?.toolOutput) acceptReview(window.openai.toolOutput);
    render();
    void acknowledgePresentation();
  },
  onUnavailable(error) {
    connected = false;
    bridgeFailure = String(error?.message || error || 'The host bridge is unavailable.');
    if (!review) render();
  },
});

function acceptReview(payload) {
  const candidate = payload?.review || payload;
  if (!Array.isArray(candidate?.files)) return;
  finalReviewReady = payload?.presentation?.mode === 'workflow-review' || candidate?.presentationMode === 'workflow-review' ||
    payload?.presentation?.mode === 'independent-operation-review' || candidate?.presentationMode === 'independent-operation-review';
  presentationError = '';
  review = candidate;
  selectedFile = 0;
  filesExpanded = false;
  fileDetailFallback = false;
  actionError = '';
  render();
  void acknowledgePresentation();
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'toolOutput' || data.toolOutput) {
    acceptReview(data.toolOutput || data);
  } else if (data.method === 'ui/notifications/tool-result' && data.params) {
    acceptReview(data.params.structuredContent || payloadOf(data.params));
  }
});

function start() {
  render();
  if (window.openai?.toolOutput) acceptReview(window.openai.toolOutput);
  void bridge.connect();
  window.addEventListener('pagehide', () => bridge.dispose(), { once: true });
}

new ResizeObserver(() => reportSize()).observe(root);
start();
