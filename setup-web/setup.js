const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let step = 1;
let selectedPath = null;
let pickerPath = null;
let pickerParent = null;
let allowedRoots = [];
let state = null;
const BRANDING_FALLBACK = { name: 'ForgeLink', developer: 'Vidit Shah', logoAsset: 'branding-logo.png' };

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 1900); }
async function loadBranding() {
  try {
    const branding = { ...BRANDING_FALLBACK, ...(await api('branding.json')) };
    document.title = `${branding.name} Setup`;
    $('#brandName').textContent = branding.name;
    $('#brandSubtitle').textContent = `${branding.developer} · MCP for ChatGPT`;
    $('#brandLogo').src = branding.logoAsset;
    $('#brandLogo').alt = `${branding.name} logo`;
  } catch {}
}
function escapeHTML(value = '') { const el = document.createElement('span'); el.textContent = value; return el.innerHTML; }
function escapeAttr(value = '') { return escapeHTML(value).replaceAll('`', '&#96;'); }
function showStep(next) {
  step = Math.min(4, Math.max(1, next));
  $$('.screen').forEach(el => el.classList.toggle('active', Number(el.dataset.screen) === step));
  $$('.step').forEach(el => { const n = Number(el.dataset.step); el.classList.toggle('active', n === step); el.classList.toggle('done', n < step); });
  $('#headerStatus').textContent = step === 4 ? 'Review setup' : `Step ${step} of 4`;
  if (step === 4) renderReview();
  scrollTo({ top: 0, behavior: 'smooth' });
}
function validateStep() {
  if (step === 2) {
    if (!/^tunnel_[A-Za-z0-9]{16,}$/.test($('#tunnelId').value.trim())) { toast('Enter a valid tunnel ID'); return false; }
    if (!$('#apiKey').value.trim().startsWith('sk-') || $('#apiKey').value.trim().length < 20) { toast('Enter a valid runtime API key'); return false; }
  }
  if (step === 3 && !allowedRoots.length) { toast('Add at least one folder'); return false; }
  return true;
}
function renderFolders() {
  $('#folderCount').textContent = `${allowedRoots.length} folder${allowedRoots.length === 1 ? '' : 's'}`;
  $('#selectedFolders').innerHTML = allowedRoots.length
    ? allowedRoots.map(root => `<div class="selected-item"><span>▣</span><code title="${escapeAttr(root)}">${escapeHTML(root)}</code><button type="button" data-remove="${escapeAttr(root)}">Remove</button></div>`).join('')
    : '<p>Choose at least one folder above.</p>';
  $$('[data-remove]').forEach(button => button.addEventListener('click', () => { allowedRoots = allowedRoots.filter(root => root.toLowerCase() !== button.dataset.remove.toLowerCase()); renderFolders(); }));
}
async function browse(path) {
  const list = $('#folderList'); list.innerHTML = '<div class="loader"></div>'; selectedPath = null; $('#addFolderButton').disabled = true;
  try {
    const data = await api(path ? `api/folders?path=${encodeURIComponent(path)}` : 'api/folders');
    pickerPath = data.path; pickerParent = data.parent; $('#folderPath').textContent = pickerPath || 'This PC'; $('#upButton').disabled = !pickerParent;
    if (!data.directories.length) { list.innerHTML = '<p style="text-align:center;color:#6e6e73;font-size:11px;margin:95px 0">No subfolders here.</p>'; return; }
    list.innerHTML = data.directories.map(item => `<button type="button" class="folder-row" data-path="${escapeAttr(item.path)}" data-kind="${item.kind}"><span class="folder-icon">${item.kind === 'drive' ? '◉' : '▰'}</span><span><strong>${escapeHTML(item.name)}</strong><small>${item.kind === 'drive' ? 'Local drive' : item.path}</small></span><b>›</b></button>`).join('');
    $$('.folder-row', list).forEach(row => row.addEventListener('click', () => {
      $$('.folder-row', list).forEach(item => item.classList.remove('selected')); row.classList.add('selected'); selectedPath = row.dataset.path;
      const isDrive = /^[A-Za-z]:\\$/.test(selectedPath); $('#selectedFolderLabel').textContent = selectedPath; $('#selectedFolderDetail').textContent = isDrive ? 'Open the drive first; drive roots cannot be shared.' : 'Ready to add this folder.'; $('#addFolderButton').disabled = isDrive;
    }));
    $$('.folder-row', list).forEach(row => row.addEventListener('dblclick', () => browse(row.dataset.path)));
  } catch (error) { list.innerHTML = `<p style="color:#d70015;font-size:11px;padding:20px">${escapeHTML(error.message)}</p>`; }
}
function renderReview() {
  const id = $('#tunnelId').value.trim(); $('#reviewTunnel').textContent = id ? `${id.slice(0, 12)}…${id.slice(-4)}` : 'Not set';
  $('#reviewFolders').textContent = `${allowedRoots.length} selected`;
  $('#reviewTerminal').textContent = $('#terminalEnabled').checked ? 'On — PowerShell enabled' : 'Off — safest default';
}
async function configure() {
  const button = $('#configureButton'); const error = $('#setupError'); error.hidden = true; button.disabled = true; $('#finishBack').disabled = true; $('#progressWrap').hidden = false;
  try {
    const result = await api('api/configure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tunnelId: $('#tunnelId').value.trim(), apiKey: $('#apiKey').value.trim(), roots: allowedRoots, terminalEnabled: $('#terminalEnabled').checked }) });
    $('#apiKey').value = ''; $('#progressText').textContent = 'Configuration encrypted. Starting ForgeLink…';
    const started = await api('api/start', { method: 'POST' });
    $('#progressText').textContent = 'Connected. Opening your local dashboard…';
    setTimeout(() => location.href = started.dashboard, 650);
  } catch (e) { error.textContent = e.message; error.hidden = false; $('#progressWrap').hidden = true; button.disabled = false; $('#finishBack').disabled = false; }
}
async function initialize() {
  try {
    state = await api('api/state');
    const windows = state.platform === 'win32'; const node = Number((state.node || 'v0').slice(1).split('.')[0]) >= 20;
    $('[data-requirement="windows"]').classList.toggle('ok', windows); $('[data-requirement="node"]').classList.toggle('ok', node); $('[data-requirement="client"]').classList.toggle('ok', state.clientInstalled);
    if (!windows || !node) toast('This setup needs Windows and Node.js 20+');
    if (state.configured) { allowedRoots = state.roots; renderFolders(); $('#tunnelId').placeholder = state.tunnelIdMasked || 'Tunnel already configured'; $('#terminalEnabled').checked = state.terminalEnabled; }
  } catch (error) { toast(error.message); }
  browse(null);
}
$$('[data-next]').forEach(button => button.addEventListener('click', () => { if (validateStep()) showStep(step + 1); }));
$$('[data-back]').forEach(button => button.addEventListener('click', () => showStep(step - 1)));
$('#revealKey').addEventListener('click', () => { const input = $('#apiKey'); input.type = input.type === 'password' ? 'text' : 'password'; $('#revealKey').textContent = input.type === 'password' ? 'Show' : 'Hide'; });
$('#drivesButton').addEventListener('click', () => browse(null)); $('#upButton').addEventListener('click', () => browse(pickerParent));
$('#addFolderButton').addEventListener('click', () => { if (!selectedPath || /^[A-Za-z]:\\$/.test(selectedPath)) return; if (allowedRoots.some(root => root.toLowerCase() === selectedPath.toLowerCase())) return toast('That folder is already added'); allowedRoots.push(selectedPath); renderFolders(); toast('Folder added'); });
$('#configureButton').addEventListener('click', configure);
loadBranding();
initialize();
