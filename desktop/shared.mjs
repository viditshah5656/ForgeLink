export function isValidTunnelId(value) {
  return /^tunnel_[a-f0-9]{32}$/.test(String(value || '').trim());
}

export function normalizeTerminalMode(value) {
  return ['off', 'safe', 'full'].includes(value) ? value : 'off';
}

export function maskTunnelId(value) {
  const id = String(value || '');
  return id ? `${id.slice(0, 12)}…${id.slice(-4)}` : 'Not configured';
}

export function redactSensitive(value) {
  return String(value?.message || value || 'Unknown error')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    .replace(/tunnel_[A-Za-z0-9]{8,}/g, 'tunnel_[REDACTED]');
}
