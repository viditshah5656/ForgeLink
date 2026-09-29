import { isValidTunnelId, maskTunnelId, normalizeAutomationMode } from './shared.mjs';

export const CONNECTION_CONFIG_VERSION = 2;
export const MIN_TUNNEL_HEALTH_PORT = 24124;
export const MAX_TUNNEL_HEALTH_PORT = 24223;

export function normalizeConnectionId(value, fallback = 'primary') {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : fallback;
}

export function normalizeConnectionName(value, index = 0) {
  const name = String(value || '').trim().replace(/\\s+/g, ' ');
  return (name || `ChatGPT Account ${index + 1}`).slice(0, 80);
}

export function normalizeHealthPort(value, fallback = MIN_TUNNEL_HEALTH_PORT) {
  const port = Number(value);
  return Number.isInteger(port) && port >= MIN_TUNNEL_HEALTH_PORT && port <= MAX_TUNNEL_HEALTH_PORT
    ? port
    : fallback;
}

export function normalizeConnection(input, index = 0, fallbackId = `account-${index + 1}`) {
  const raw = input && typeof input === 'object' ? input : {};
  const id = normalizeConnectionId(raw.id, fallbackId);
  return {
    id,
    name: normalizeConnectionName(raw.name ?? raw.label, index),
    tunnelId: String(raw.tunnelId || '').trim(),
    healthPort: normalizeHealthPort(raw.healthPort, MIN_TUNNEL_HEALTH_PORT + index),
    enabled: raw.enabled !== false,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now(),
  };
}

export function normalizeConfiguration(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  let connections;
  if (Array.isArray(value.connections)) {
    connections = value.connections.map((item, index) => normalizeConnection(item, index, `account-${index + 1}`));
  } else if (value.tunnelId) {
    connections = [normalizeConnection({
      id: 'primary',
      name: 'Primary ChatGPT account',
      tunnelId: value.tunnelId,
      healthPort: MIN_TUNNEL_HEALTH_PORT,
      enabled: true,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }, 0, 'primary')];
  } else {
    connections = [];
  }

  const seen = new Set();
  connections = connections.map((connection, index) => {
    let id = connection.id;
    if (seen.has(id)) id = `account-${index + 1}`;
    seen.add(id);
    return { ...connection, id };
  });

  const normalized = {
    ...value,
    version: CONNECTION_CONFIG_VERSION,
    allowedRoots: Array.isArray(value.allowedRoots) ? value.allowedRoots : [],
    terminalMode: ['off', 'safe', 'full'].includes(value.terminalMode) ? value.terminalMode : 'off',
    systemControlMode: ['off', 'read', 'full'].includes(value.systemControlMode) ? value.systemControlMode : 'off',
    automationMode: normalizeAutomationMode(value.automationMode),
    headlessBackground: value.headlessBackground === true,
    launchAtLogin: value.launchAtLogin === true,
    connections,
  };
  delete normalized.tunnelId;
  delete normalized.apiKey;
  delete normalized.healthPort;
  return normalized;
}

export function normalizeSecrets(raw, connections = []) {
  const value = raw && typeof raw === 'object' ? raw : {};
  if (value.version === CONNECTION_CONFIG_VERSION && value.connections && typeof value.connections === 'object') {
    return { ...value, version: CONNECTION_CONFIG_VERSION, connections: { ...value.connections } };
  }

  const first = connections[0];
  if (value.apiKey && first) {
    return {
      version: CONNECTION_CONFIG_VERSION,
      connections: {
        [first.id]: { apiKey: value.apiKey },
      },
    };
  }

  return { version: CONNECTION_CONFIG_VERSION, connections: {} };
}

export function maskConnection(connection) {
  return {
    ...connection,
    tunnelIdMasked: maskTunnelId(connection.tunnelId),
    tunnelId: connection.tunnelId,
  };
}

export function sanitizeConfiguration(config, runtimeConnections = {}) {
  const normalized = normalizeConfiguration(config);
  return {
    ...normalized,
    connections: normalized.connections.map((connection) => ({
      ...maskConnection(connection),
      runtime: runtimeConnections[connection.id] || { state: 'stopped' },
    })),
  };
}

export function validateConnectionInput(input, existingSecret = '') {
  const name = normalizeConnectionName(input?.name || input?.label, 0);
  const tunnelId = String(input?.tunnelId || '').trim();
  const apiKey = String(input?.apiKey || '').trim();
  if (!name) throw new Error('Enter a name for this ChatGPT account.');
  if (!isValidTunnelId(tunnelId)) throw new Error('The tunnel ID must look like tunnel_ followed by 32 lowercase letters or numbers.');
  if (!apiKey && !existingSecret) throw new Error('Paste the runtime API key once. It will be encrypted on this computer.');
  if (apiKey && (!apiKey.startsWith('sk-') || apiKey.length < 20)) throw new Error('That runtime API key does not look valid.');
  return { name, tunnelId, apiKey };
}

export function buildTunnelProfile(connection, port = connection.healthPort) {
  const healthPort = normalizeHealthPort(port, connection.healthPort);
  const tunnelId = String(connection.tunnelId || '').trim();
  return `config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: "${tunnelId}"
  api_key: "env:CONTROL_PLANE_API_KEY"
health:
  listen_addr: "127.0.0.1:${healthPort}"
admin_ui:
  open_browser: false
log:
  level: info
  format: json
mcp:
  server_urls:
    - channel: main
      url: "http://127.0.0.1:24024/mcp"
`;
}

export function chooseNextHealthPort(connections = [], usedPorts = new Set()) {
  const occupied = new Set(
    connections
      .map((connection) => Number(connection.healthPort))
      .filter((port) => Number.isInteger(port)),
  );
  for (const port of usedPorts) occupied.add(Number(port));
  for (let port = MIN_TUNNEL_HEALTH_PORT; port <= MAX_TUNNEL_HEALTH_PORT; port += 1) {
    if (!occupied.has(port)) return port;
  }
  throw new Error('ForgeLink has reached the supported tunnel connection limit.');
}
