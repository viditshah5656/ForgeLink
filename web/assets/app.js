const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const icons = {
  overview: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  files: '<path d="M3 6.5h7l2 2h9v10.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 8.5V6a2 2 0 0 1 2-2h4l2 2h6"/>',
  tools: '<path d="M14.7 6.3a4 4 0 0 0-5-5l2.1 2.1-2.4 2.4-2.1-2.1a4 4 0 0 0 5 5l7.2 7.2a2.1 2.1 0 0 1-3 3l-7.2-7.2a4 4 0 0 0-5 5l2.1-2.1 2.4 2.4-2.1 2.1a4 4 0 0 0 5-5"/>',
  security: '<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  setup: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  refresh: '<path d="M20 11a8.1 8.1 0 1 0 2 5.3"/><path d="M20 4v7h-7"/>',
  folder: '<path d="M3 6.5h7l2 2h9v10.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  pulse: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  code: '<path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};

function icon(name, cls = '') { return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.code}</svg>`; }

const page = document.body.dataset.page || 'overview';
const nav = [
  ['overview', 'Overview', 'index.html'],
  ['files', 'Files', 'files.html'],
  ['terminal', 'Terminal', 'terminal.html'],
  ['tools', 'MCP Tools', 'tools.html'],
  ['security', 'Security', 'security.html'],
  ['setup', 'Setup & Logs', 'setup.html'],
];

$('#sidebar').innerHTML = `
  <a class="brand" href="index.html"><span class="brand-mark"></span><span><strong>Local Files</strong><span>MCP Control Center</span></span></a>
  <div class="nav-label">Workspace</div>
  <nav class="nav">${nav.map(([id, label, href]) => `<a class="nav-link ${page === id ? 'active' : ''}" href="${href}">${icon(id)}<span>${label}</span></a>`).join('')}</nav>
  <div class="sidebar-bottom">
    <div class="mini-status"><span class="status-dot" data-live-dot></span><div><strong data-live-label>Checking services</strong><span>C:\\Coding</span></div></div>
    <div class="nav-label">Local & private</div>
  </div>`;

$('#topbar').innerHTML = `
  <div style="display:flex;align-items:center;gap:11px"><button class="icon-button mobile-menu" id="menuButton" aria-label="Open menu">${icon('menu')}</button><span class="eyebrow">Local Files / ${nav.find(x => x[0] === page)?.[1]}</span></div>
  <div class="topbar-actions"><button class="icon-button" id="refreshButton" aria-label="Refresh">${icon('refresh')}</button><button class="icon-button" id="themeButton" aria-label="Change theme"></button></div>`;

const storedTheme = localStorage.getItem('mcp-theme');
if (storedTheme) document.documentElement.dataset.theme = storedTheme;
else if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
function updateThemeIcon() { $('#themeButton').innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'); }
updateThemeIcon();
$('#themeButton').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next; localStorage.setItem('mcp-theme', next); updateThemeIcon();
});
$('#menuButton')?.addEventListener('click', () => document.body.classList.toggle('menu-open'));
document.addEventListener('click', e => { if (innerWidth <= 820 && document.body.classList.contains('menu-open') && !e.target.closest('.sidebar') && !e.target.closest('#menuButton')) document.body.classList.remove('menu-open'); });
addEventListener('scroll', () => $('#topbar').classList.toggle('scrolled', scrollY > 4), { passive: true });

let status;
async function fetchJSON(url) { const response = await fetch(url); const data = await response.json(); if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`); return data; }
async function loadStatus() {
  try {
    status = await fetchJSON('api/status');
    const fullyLive = status.server === 'online' && status.tunnel === 'ready';
    $$('[data-live-dot]').forEach(el => el.className = `status-dot ${fullyLive ? 'live' : 'warn'}`);
    $$('[data-live-label]').forEach(el => el.textContent = fullyLive ? 'All systems ready' : 'Server online · tunnel offline');
    $$('[data-status]').forEach(el => { const key = el.dataset.status; el.textContent = key === 'uptime' ? formatUptime(status.uptimeSeconds) : status[key] ?? '—'; });
    $$('[data-tunnel-state]').forEach(el => { el.textContent = status.tunnel === 'ready' ? 'Ready' : 'Offline'; el.className = `badge ${status.tunnel === 'ready' ? 'read' : 'write'}`; });
    window.dispatchEvent(new CustomEvent('mcp:status', { detail: status }));
  } catch {
    $$('[data-live-label]').forEach(el => el.textContent = 'Dashboard unavailable');
  }
}
function formatUptime(seconds = 0) { const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
function formatBytes(bytes = 0) { if (!bytes) return '0 B'; const units = ['B','KB','MB','GB']; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3); return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`; }
function timeAgo(value) { const seconds = Math.floor((Date.now() - new Date(value)) / 1000); if (seconds < 60) return 'Just now'; if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds/3600)}h ago`; return new Date(value).toLocaleDateString(); }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 1800); }
async function copyText(value) { try { await navigator.clipboard.writeText(value); toast('Copied to clipboard'); } catch { toast('Could not copy'); } }
$$('[data-copy]').forEach(el => el.addEventListener('click', () => copyText(el.dataset.copy)));
$('#refreshButton').addEventListener('click', () => { loadStatus(); window.dispatchEvent(new Event('mcp:refresh')); $('#refreshButton').animate([{ transform:'rotate(0)' }, { transform:'rotate(360deg)' }], { duration:450 }); });

async function initFiles() {
  const body = $('#fileBody'), crumbs = $('#breadcrumbs'), search = $('#fileSearch');
  if (!body) return;
  let current = '', currentRoot = '', relativePath = '.', allItems = [];
  async function load(requested) {
    body.innerHTML = `<tr><td colspan="3"><div class="empty-state"><span class="spinner"></span></div></td></tr>`;
    try { const data = await fetchJSON(requested ? `api/directory?path=${encodeURIComponent(requested)}` : 'api/directory'); current = data.absolutePath; currentRoot = data.root; relativePath = data.path; allItems = data.items; renderCrumbs(); render(); renderRootPicker(data.roots); $('#fileCount').textContent = `${data.items.length}${data.truncated ? '+' : ''} items`; }
    catch (error) { body.innerHTML = `<tr><td colspan="3"><div class="empty-state">${icon('alert')}<div>${escapeHTML(error.message)}</div></div></td></tr>`; }
  }
  function renderCrumbs() {
    const parts = relativePath === '.' ? [] : relativePath.split('/');
    crumbs.innerHTML = `<button data-path="${escapeAttr(currentRoot)}">${escapeHTML(currentRoot)}</button>${parts.map((part, i) => `<span>›</span><button data-path="${escapeAttr(currentRoot + '\\' + parts.slice(0,i+1).join('\\'))}">${escapeHTML(part)}</button>`).join('')}`;
    $$('button', crumbs).forEach(b => b.addEventListener('click', () => load(b.dataset.path)));
  }
  function renderRootPicker(roots = []) { const picker=$('#rootPicker'); if (!picker) return; picker.innerHTML=roots.map(root=>`<option value="${escapeAttr(root)}" ${root.toLowerCase()===currentRoot.toLowerCase()?'selected':''}>${escapeHTML(root)}</option>`).join(''); }
  function render() {
    const q = search.value.trim().toLowerCase(); const items = allItems.filter(x => x.name.toLowerCase().includes(q));
    if (!items.length) { body.innerHTML = `<tr><td colspan="3"><div class="empty-state">${icon('search')}<div>${q ? 'No matching files' : 'This folder is empty'}</div></div></td></tr>`; return; }
    body.innerHTML = items.map(item => `<tr class="file-row" data-type="${item.type}" data-path="${escapeAttr(item.path)}"><td><span class="file-name">${icon(item.type === 'directory' ? 'folder' : 'file')}<span>${escapeHTML(item.name)}</span></span></td><td class="file-meta">${item.type === 'directory' ? 'Folder' : formatBytes(item.size)}</td><td class="file-meta">${timeAgo(item.modified)}</td></tr>`).join('');
    $$('.file-row', body).forEach(row => row.addEventListener('click', () => row.dataset.type === 'directory' ? load(row.dataset.path) : openPreview(row.dataset.path)));
  }
  search.addEventListener('input', render); $('#rootPicker')?.addEventListener('change', e => load(e.target.value)); window.addEventListener('mcp:refresh', () => load(current)); load();
}
async function openPreview(path) {
  const drawer = $('#previewDrawer'), backdrop = $('#drawerBackdrop'); drawer.classList.add('open'); backdrop.classList.add('open');
  $('#previewName').textContent = path.split('/').pop(); $('#previewMeta').textContent = path; $('#previewContent').innerHTML = '<span class="spinner"></span>';
  $('#copyPath').onclick = () => copyText(path);
  try { const data = await fetchJSON(`api/file?path=${encodeURIComponent(path)}`); $('#previewMeta').textContent = `${formatBytes(data.size)} · Read-only preview`; $('#previewContent').textContent = data.content; }
  catch (error) { $('#previewContent').textContent = `Preview unavailable\n\n${error.message}`; }
}
function closePreview() { $('#previewDrawer')?.classList.remove('open'); $('#drawerBackdrop')?.classList.remove('open'); }
$('#closePreview')?.addEventListener('click', closePreview); $('#drawerBackdrop')?.addEventListener('click', closePreview); addEventListener('keydown', e => { if (e.key === 'Escape') closePreview(); });

async function initTools() {
  const grid = $('#toolsGrid'); if (!grid) return; let tools = [], filter = 'All';
  function render() { const q = $('#toolSearch').value.toLowerCase(); const visible = tools.filter(t => (filter === 'All' || t.access === filter) && `${t.name} ${t.description}`.toLowerCase().includes(q)); $('#toolCount').textContent = `${visible.length} tools`; grid.innerHTML = visible.map(t => `<article class="card tool-card"><div class="tool-card-head"><span class="tool-glyph">${icon(t.access === 'Read' ? 'search' : t.access === 'Write' ? 'code' : t.access === 'Execute' ? 'terminal' : 'alert')}</span><span class="badge ${t.access.toLowerCase()}">${t.access}</span></div><h3>${escapeHTML(t.name)}</h3><p>${escapeHTML(t.description)}</p></article>`).join(''); }
  try { tools = (await fetchJSON('api/tools')).tools; render(); } catch (e) { grid.innerHTML = `<div class="empty-state">${e.message}</div>`; }
  $('#toolSearch').addEventListener('input', render); $$('#toolFilters button').forEach(b => b.addEventListener('click', () => { $$('#toolFilters button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); filter=b.dataset.filter; render(); }));
}

async function initLogs() {
  const output = $('#logOutput'); if (!output) return; let source = 'tunnel';
  async function load() { output.textContent = 'Loading logs…'; try { const data = await fetchJSON(`api/logs?source=${source}`); output.innerHTML = data.lines.length ? data.lines.map(l=>`<span class="log-line">${escapeHTML(l)}</span>`).join('') : '<span class="log-line">No log entries yet.</span>'; output.scrollTop = output.scrollHeight; $('#logUpdated').textContent = `Updated ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`; } catch(e) { output.textContent=e.message; } }
  $$('#logTabs button').forEach(b => b.addEventListener('click', () => { $$('#logTabs button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); source=b.dataset.source; load(); }));
  window.addEventListener('mcp:refresh', load); load();
}

async function initFolderManager() {
  const list = $('#rootList'); if (!list) return;
  async function refresh() { const data = await fetchJSON('api/status'); render(data.roots); }
  function render(roots) {
    $('#rootCount').textContent = `${roots.length} folder${roots.length === 1 ? '' : 's'}`;
    list.innerHTML = roots.map((root, index) => `<div class="root-row"><span class="metric-icon">${icon('folder')}</span><div><strong>${escapeHTML(root)}</strong><span>${index === 0 ? 'Primary folder · relative paths start here' : 'Additional allowed folder'}</span></div><button class="button secondary root-remove" data-root="${escapeAttr(root)}" ${roots.length === 1 ? 'disabled' : ''}>Remove</button></div>`).join('');
    $$('.root-remove', list).forEach(button => button.addEventListener('click', async () => { if (!confirm(`Remove ${button.dataset.root} from ChatGPT access? Files will not be deleted.`)) return; try { await fetchJSONWithBody('api/roots', 'DELETE', { path: button.dataset.root }); toast('Folder access removed'); await refresh(); loadStatus(); } catch(e) { toast(e.message); } }));
  }
  $('#addRootForm').addEventListener('submit', async e => { e.preventDefault(); const input=$('#rootInput'); try { const result=await fetchJSONWithBody('api/roots','POST',{path:input.value.trim()}); input.value=''; render(result.roots); toast('Folder added to ChatGPT access'); loadStatus(); } catch(error) { toast(error.message); } });
  refresh();
}

function initFolderPicker() {
  const modal=$('#folderPicker'), backdrop=$('#folderPickerBackdrop'); if(!modal)return;
  const list=$('#pickerList'), pathLabel=$('#pickerPath'), up=$('#pickerUp'), choose=$('#chooseFolder'); let current=null, parent=null;
  function setOpen(open){ modal.classList.toggle('open',open); backdrop.classList.toggle('open',open); document.body.classList.toggle('modal-open',open); }
  async function browse(path) {
    list.innerHTML='<div class="empty-state"><span class="spinner"></span></div>'; choose.disabled=true;
    try {
      const data=await fetchJSON(path?`api/folder-picker?path=${encodeURIComponent(path)}`:'api/folder-picker'); current=data.path; parent=data.parent; pathLabel.textContent=current||'This PC'; up.disabled=!current;
      const isDrive=current&&/^[a-z]:\\$/i.test(current); choose.disabled=!current||isDrive;
      $('#pickerHint').textContent=isDrive?'Open a folder inside the drive to select it.':current?'This folder will be added immediately.':'Open a drive, then browse to your coding folder.';
      if(!data.directories.length){list.innerHTML='<div class="empty-state">This folder has no subfolders. You can still select it below.</div>';return;}
      list.innerHTML=data.directories.map(item=>`<button class="picker-row" type="button" data-path="${escapeAttr(item.path)}"><span class="metric-icon">${icon(item.kind==='drive'?'database':'folder')}</span><span><strong>${escapeHTML(item.name)}</strong><small>${item.kind==='drive'?'Local drive':'Folder'}</small></span><b>›</b></button>`).join('');
      $$('.picker-row',list).forEach(row=>row.addEventListener('click',()=>browse(row.dataset.path)));
    } catch(error){list.innerHTML=`<div class="empty-state">${icon('alert')}<div>${escapeHTML(error.message)}</div></div>`;}
  }
  $('#browseRoot').addEventListener('click',()=>{setOpen(true);browse(status?.root||null);});
  $('#closeFolderPicker').addEventListener('click',()=>setOpen(false)); backdrop.addEventListener('click',()=>setOpen(false));
  $('#pickerDrives').addEventListener('click',()=>browse(null)); up.addEventListener('click',()=>browse(parent));
  choose.addEventListener('click',()=>{if(!current)return;$('#rootInput').value=current;setOpen(false);$('#addRootForm').requestSubmit();});
  addEventListener('keydown',e=>{if(e.key==='Escape'&&modal.classList.contains('open'))setOpen(false);});
}

async function fetchJSONWithBody(url, method, body) { const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data=await response.json(); if(!response.ok) throw new Error(data.error||`Request failed (${response.status})`); return data; }

async function initTerminal() {
  const form=$('#terminalForm'); if (!form) return;
  const output=$('#terminalOutput'), input=$('#terminalInput'), toggle=$('#terminalToggle'), run=$('#terminalRun'), cwd=$('#terminalCwd');
  function applyStatus(data) { toggle.checked=data.terminalEnabled; run.disabled=!data.terminalEnabled; $('#terminalState').textContent=data.terminalEnabled?'Enabled':'Disabled'; $('#terminalState').className=`badge ${data.terminalEnabled?'execute':'delete'}`; cwd.innerHTML=data.roots.map(root=>`<option value="${escapeAttr(root)}">${escapeHTML(root)}</option>`).join(''); }
  window.addEventListener('mcp:status', e=>applyStatus(e.detail)); if(status) applyStatus(status);
  toggle.addEventListener('change', async()=>{ const enabled=toggle.checked; if(enabled&&!confirm('Terminal access lets ChatGPT run PowerShell commands on this PC, including commands outside allowed folders. Enable it?')){toggle.checked=false;return;} try{await fetchJSONWithBody('api/terminal/settings','POST',{enabled}); toast(`Terminal access ${enabled?'enabled':'disabled'}`); loadStatus();}catch(e){toggle.checked=!enabled;toast(e.message);} });
  form.addEventListener('submit', async e=>{ e.preventDefault(); const command=input.value.trim(); if(!command)return; run.disabled=true; output.textContent=`PS ${cwd.value}> ${command}\n\nRunning…`; try{const result=await fetchJSONWithBody('api/terminal/run','POST',{command,cwd:cwd.value,timeoutSeconds:60}); output.textContent=`PS ${result.cwd}> ${command}\n\n${result.stdout||''}${result.stderr?`\n${result.stderr}`:''}\n[exit ${result.exitCode}]`; input.value='';}catch(error){output.textContent+=`\n\nERROR: ${error.message}`;}finally{run.disabled=!toggle.checked;output.scrollTop=output.scrollHeight;} });
  $$('.command-chip').forEach(chip=>chip.addEventListener('click',()=>{input.value=chip.dataset.command;input.focus();}));
}
function escapeHTML(value='') { const d=document.createElement('div'); d.textContent=value; return d.innerHTML; }
function escapeAttr(value='') { return escapeHTML(value).replaceAll('`','&#96;'); }

loadStatus(); initFiles(); initTools(); initLogs(); initFolderManager(); initFolderPicker(); initTerminal();
