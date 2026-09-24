import './style.css';

const bridge = window.localFiles;
const app = document.querySelector('#app');
let state;
let step = 0;
let roots = [];

const steps = [
  { label: 'Welcome', hint: 'Everything is included' },
  { label: 'Folders', hint: 'You stay in control' },
  { label: 'Connect', hint: 'Private OpenAI tunnel' },
  { label: 'Permissions', hint: 'Choose the safe level' },
  { label: 'Finish', hint: 'Review and start' },
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, handler) {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function maskTunnel(id = '') {
  return id ? `${id.slice(0, 12)}…${id.slice(-4)}` : 'Not configured';
}

function statusDot(status) {
  return `<span class="status-dot ${status}"></span>`;
}

function renderShell(content, activeStep = -1) {
  app.replaceChildren();
  const shell = element('div', 'shell');
  const sidebar = element('aside', 'sidebar');
  const brand = element('div', 'brand');
  brand.innerHTML = '<span class="brand-icon">LF</span><span><strong>Local Files</strong><small>for ChatGPT</small></span>';
  sidebar.append(brand);
  const nav = element('div', 'step-list');
  steps.forEach((item, index) => {
    const row = element('div', `step ${index === activeStep ? 'active' : ''} ${index < activeStep ? 'done' : ''}`);
    row.innerHTML = `<span class="step-number">${index < activeStep ? '✓' : index + 1}</span><span><strong>${item.label}</strong><small>${item.hint}</small></span>`;
    nav.append(row);
  });
  sidebar.append(nav);
  const trust = element('div', 'trust-card');
  trust.innerHTML = '<span>🔒</span><div><strong>Private by design</strong><small>Files stay on this computer. Only folders you select are available.</small></div>';
  sidebar.append(trust);
  const main = element('main', 'main');
  const top = element('header', 'topbar');
  top.innerHTML = `<span>Desktop setup</span><span class="platform">${state.platform === 'darwin' ? 'macOS' : 'Windows'} · v${state.version}</span>`;
  main.append(top, content);
  shell.append(sidebar, main);
  app.append(shell);
}

function panel(eyebrow, title, copy) {
  const wrap = element('section', 'panel');
  wrap.append(element('p', 'eyebrow', eyebrow), element('h1', '', title), element('p', 'lede', copy));
  return wrap;
}

function actions(back, next, nextLabel = 'Continue') {
  const row = element('div', 'actions');
  if (back) row.append(button('Back', 'btn secondary', back));
  row.append(button(nextLabel, 'btn primary', next));
  return row;
}

function toast(message, type = 'info') {
  document.querySelector('.toast')?.remove();
  const node = element('div', `toast ${type}`, message);
  document.body.append(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => node.remove(), 3200);
}

function showWelcome() {
  step = 0;
  const content = panel('No command line needed', 'Your private bridge to ChatGPT.', 'This app installs and runs everything needed for ChatGPT to work with folders on this computer. You choose exactly what it can see.');
  const cards = element('div', 'feature-grid');
  [
    ['✓', 'Runtime included', 'No Node.js, Terminal, or PowerShell setup.'],
    [state.tunnelBundled ? '✓' : '!', 'Secure tunnel included', state.tunnelBundled ? 'Official OpenAI tunnel client is ready.' : 'The tunnel component is missing from this build.'],
    ['✓', 'Local and private', 'The backend listens only on this computer.'],
  ].forEach(([icon, title, copy]) => {
    const card = element('article', 'feature-card');
    card.innerHTML = `<span>${icon}</span><div><strong>${title}</strong><small>${copy}</small></div>`;
    cards.append(card);
  });
  content.append(cards);
  const note = element('div', 'note');
  note.innerHTML = '<strong>You will need two things from OpenAI:</strong> a Tunnel ID and a runtime API key. We will open the right pages when you reach that step.';
  content.append(note, actions(null, showFolders, 'Start easy setup'));
  renderShell(content, step);
}

function rootsList(container) {
  container.replaceChildren();
  if (!roots.length) {
    container.append(element('p', 'empty', 'No folders selected yet.'));
    return;
  }
  roots.forEach((root) => {
    const row = element('div', 'root-row');
    const text = element('div');
    text.append(element('strong', '', root.split(/[\\/]/).filter(Boolean).at(-1) || root), element('small', '', root));
    row.append(element('span', 'folder-mark', '▰'), text, button('Remove', 'text-button', () => { roots = roots.filter((item) => item !== root); rootsList(container); }));
    container.append(row);
  });
}

function showFolders() {
  step = 1;
  const content = panel('Step 2 of 5', 'Choose what ChatGPT may use.', 'Pick one or more project folders. The app blocks access everywhere else, including your full disk.');
  const picker = element('div', 'picker');
  const list = element('div', 'roots-list');
  rootsList(list);
  const choose = button('Choose folders…', 'btn choose', async () => {
    const selected = await bridge.chooseFolders();
    for (const root of selected) if (!roots.includes(root)) roots.push(root);
    rootsList(list);
  });
  picker.append(choose, list);
  content.append(picker, actions(showWelcome, () => roots.length ? showConnection() : toast('Choose at least one folder first.', 'error')));
  renderShell(content, step);
}

function field(label, id, placeholder, secret = false) {
  const wrapper = element('label', 'field');
  wrapper.append(element('span', '', label));
  const input = element('input');
  input.id = id;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.type = secret ? 'password' : 'text';
  wrapper.append(input);
  return wrapper;
}

function showConnection() {
  step = 2;
  const content = panel('Step 3 of 5', 'Connect the private tunnel.', 'Open the two OpenAI pages below, create a tunnel and a runtime key, then paste them here. The key is encrypted by Windows or macOS and never shown again.');
  const linksRow = element('div', 'link-grid');
  linksRow.append(
    button('① Create or find a tunnel ↗', 'link-card', () => bridge.openExternal('tunnels')),
    button('② Create a runtime API key ↗', 'link-card', () => bridge.openExternal('keys')),
  );
  const form = element('div', 'form');
  const tunnelField = field('Tunnel ID', 'tunnel-id', 'Paste the tunnel ID from OpenAI');
  const keyField = field('Runtime API key', 'api-key', state.configured ? 'Leave blank to keep the saved key' : 'sk-…', true);
  tunnelField.querySelector('input').value = state.draft?.tunnelId || state.configuration?.tunnelId || '';
  form.append(tunnelField, keyField);
  const help = element('button', 'text-link', 'What permissions should the key have?');
  help.type = 'button';
  help.addEventListener('click', () => bridge.openExternal('guide'));
  form.append(help);
  content.append(linksRow, form, actions(showFolders, () => {
    const id = document.querySelector('#tunnel-id').value.trim();
    const key = document.querySelector('#api-key').value.trim();
    if (!/^tunnel_[a-f0-9]{32}$/.test(id)) return toast('Paste the complete tunnel ID.', 'error');
    if (!state.configured && (!key.startsWith('sk-') || key.length < 20)) return toast('Paste the runtime API key.', 'error');
    state.draft = { tunnelId: id, apiKey: key };
    showPermissions();
  }));
  renderShell(content, step);
}

function showPermissions() {
  step = 3;
  const content = panel('Step 4 of 5', 'Choose how much it can do.', 'File access always stays inside your selected folders. Terminal access is optional and can be changed later.');
  const choices = element('div', 'permission-list');
  const current = state.draft?.terminalMode || state.configuration?.terminalMode || 'off';
  [
    ['off', 'Files only', 'Read, create, edit, move, and delete files. Safest choice.', 'Recommended'],
    ['safe', 'Files + project tasks', 'Also run bounded Git, test, build, and package commands.', 'For coding'],
    ['full', 'Full terminal', 'Allow arbitrary shell commands with your computer account permissions.', 'Advanced'],
  ].forEach(([value, title, copy, badge]) => {
    const label = element('label', 'permission');
    const radio = element('input'); radio.type = 'radio'; radio.name = 'terminal-mode'; radio.value = value; radio.checked = current === value;
    const body = element('span'); body.append(element('strong', '', title), element('small', '', copy));
    label.append(radio, body, element('em', '', badge));
    choices.append(label);
  });
  const startup = element('label', 'startup-toggle');
  const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.id = 'launch-at-login'; checkbox.checked = state.launchAtLogin;
  const startupText = element('span'); startupText.append(element('strong', '', 'Start when I sign in'), element('small', '', 'Keeps the private bridge ready without reopening the app.'));
  startup.append(checkbox, startupText);
  content.append(choices, startup, actions(showConnection, () => {
    state.draft.terminalMode = document.querySelector('input[name="terminal-mode"]:checked').value;
    state.draft.launchAtLogin = checkbox.checked;
    showFinish();
  }));
  renderShell(content, step);
}

function showFinish() {
  step = 4;
  const content = panel('Step 5 of 5', 'One click and you are ready.', 'Review the simple summary below. Your secret key is encrypted locally and is never written to Git or displayed in logs.');
  const summary = element('div', 'summary');
  const items = [
    ['Tunnel', maskTunnel(state.draft.tunnelId)],
    ['Folders', `${roots.length} selected`],
    ['Terminal', state.draft.terminalMode === 'off' ? 'Files only' : state.draft.terminalMode === 'safe' ? 'Guarded project tasks' : 'Full terminal'],
    ['Startup', state.draft.launchAtLogin ? 'Starts at sign-in' : 'Open manually'],
  ];
  items.forEach(([key, value]) => { const row = element('div'); row.append(element('span', '', key), element('strong', '', value)); summary.append(row); });
  const safety = element('div', 'safety');
  safety.innerHTML = '<p>✓ Credentials encrypted by your operating system</p><p>✓ Service bound to localhost only</p><p>✓ Access restricted to your selected folders</p>';
  const actionRow = element('div', 'actions');
  actionRow.append(button('Back', 'btn secondary', showPermissions));
  const finish = button('Save securely & connect', 'btn primary', async () => {
    finish.disabled = true; finish.textContent = 'Saving securely…';
    const result = await bridge.saveConfiguration({ ...state.draft, roots });
    if (!result.ok) { finish.disabled = false; finish.textContent = 'Save securely & connect'; return toast(result.error, 'error'); }
    state.configured = true; state.configuration = result.configuration; state.launchAtLogin = state.draft.launchAtLogin;
    finish.textContent = 'Starting private bridge…';
    const started = await bridge.start();
    if (!started.ok) { finish.disabled = false; finish.textContent = 'Try connecting again'; return toast(started.error, 'error'); }
    showHome();
  });
  actionRow.append(finish);
  content.append(summary, safety, actionRow);
  renderShell(content, step);
}

function updateHomeStatus(status) {
  state.runtime = status;
  const card = document.querySelector('#runtime-card');
  if (!card) return;
  card.className = `runtime-card ${status.state}`;
  card.querySelector('.runtime-title').textContent = status.message;
  card.querySelector('.runtime-detail').textContent = status.detail || (status.state === 'running' ? 'Your private connection is ready.' : 'Your folders remain private while stopped.');
  card.querySelector('.runtime-icon').innerHTML = statusDot(status.state);
  const toggle = card.querySelector('#runtime-toggle');
  toggle.textContent = status.state === 'running' ? 'Stop' : status.state === 'starting' ? 'Starting…' : 'Start';
  toggle.disabled = status.state === 'starting';
}

function showHome() {
  const content = panel('Setup complete', 'Local Files is ready.', 'Keep this app running whenever you want ChatGPT to work with your local projects.');
  const runtime = element('div', `runtime-card ${state.runtime.state}`); runtime.id = 'runtime-card';
  const runtimeIcon = element('div', 'runtime-icon'); runtimeIcon.innerHTML = statusDot(state.runtime.state);
  const runtimeText = element('div'); runtimeText.append(element('strong', 'runtime-title', state.runtime.message), element('small', 'runtime-detail', state.runtime.detail || 'Your folders remain private while stopped.'));
  const toggle = button(state.runtime.state === 'running' ? 'Stop' : 'Start', 'btn runtime-button', async () => {
    toggle.disabled = true;
    const result = state.runtime.state === 'running' ? await bridge.stop() : await bridge.start();
    if (!result.ok) toast(result.error, 'error');
    else updateHomeStatus(result.status);
  }); toggle.id = 'runtime-toggle';
  runtime.append(runtimeIcon, runtimeText, toggle);
  const cards = element('div', 'home-grid');
  const connect = element('article', 'home-card');
  connect.innerHTML = `<span class="card-kicker">CHATGPT</span><h2>Connect the plugin</h2><p>Open ChatGPT settings, add a custom plugin, choose <strong>Tunnel</strong>, then select <strong>${maskTunnel(state.configuration.tunnelId)}</strong>.</p>`;
  connect.append(button('Open ChatGPT settings ↗', 'btn primary compact', () => bridge.openExternal('chatgpt')));
  const manage = element('article', 'home-card');
  manage.innerHTML = `<span class="card-kicker">LOCAL CONTROL</span><h2>Manage your folders</h2><p>${state.configuration.allowedRoots.length} folder${state.configuration.allowedRoots.length === 1 ? '' : 's'} allowed · ${state.configuration.terminalMode === 'off' ? 'files only' : `${state.configuration.terminalMode} terminal mode`}.</p>`;
  manage.append(button('Open local dashboard ↗', 'btn secondary compact', () => bridge.openDashboard()));
  cards.append(connect, manage);
  const footer = element('div', 'home-actions');
  footer.append(button('Change setup', 'text-button', () => { roots = [...state.configuration.allowedRoots]; showFolders(); }), button('Help & source ↗', 'text-button', () => bridge.openExternal('github')));
  content.append(runtime, cards, footer);
  renderShell(content, -1);
}

async function initialize() {
  if (!bridge) {
    app.textContent = 'This screen must be opened inside the Local Files desktop application.';
    return;
  }
  state = await bridge.getState();
  roots = [...(state.configuration?.allowedRoots || [])];
  bridge.onStatus((status) => updateHomeStatus(status));
  if (state.configured) showHome();
  else showWelcome();
}

initialize().catch((error) => {
  app.textContent = `Local Files could not start: ${error.message}`;
});
