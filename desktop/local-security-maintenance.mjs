export const LOCAL_SECURITY_MAINTENANCE_TTL_MS = 15 * 60_000;

export const LOCAL_SECURITY_MAINTENANCE_DURATIONS = Object.freeze({
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '5h': 5 * 3600_000,
  '15h': 15 * 3600_000,
  '1day': 24 * 3600_000,
});

export const MAINTENANCE_DURATION_LABELS = Object.freeze({
  '15m': '15 minutes',
  '30m': '30 minutes',
  '1h': '1 hour',
  '5h': '5 hours',
  '15h': '15 hours',
  '1day': '1 day',
});

export function parseMaintenanceDurationMs(value, defaultMs = LOCAL_SECURITY_MAINTENANCE_TTL_MS) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (LOCAL_SECURITY_MAINTENANCE_DURATIONS[key]) return LOCAL_SECURITY_MAINTENANCE_DURATIONS[key];
    if (key === '1d' || key === '24h') return LOCAL_SECURITY_MAINTENANCE_DURATIONS['1day'];
  }
  return defaultMs;
}

export function formatMaintenanceDurationLabel(value) {
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (MAINTENANCE_DURATION_LABELS[key]) return MAINTENANCE_DURATION_LABELS[key];
    if (key === '1d' || key === '24h') return '1 day';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    for (const [k, ms] of Object.entries(LOCAL_SECURITY_MAINTENANCE_DURATIONS)) {
      if (ms === value) return MAINTENANCE_DURATION_LABELS[k];
    }
    const mins = Math.round(value / 60_000);
    if (mins >= 60) return `${Math.round(mins / 60)} hours`;
    return `${mins} minutes`;
  }
  return '15 minutes';
}

export function normalizeLocalSecurityMaintenanceState(state = {}, now = Date.now()) {
  const expiresAt = Number(state?.expiresAt);
  const enabled = state?.enabled === true && Number.isFinite(expiresAt) && expiresAt > now;
  const result = {
    enabled,
    expiresAt: enabled ? expiresAt : null,
    remainingMs: enabled ? Math.max(0, expiresAt - now) : 0,
  };
  if (enabled && state?.durationMs) result.durationMs = Number(state.durationMs);
  return result;
}

export function applyLocalSecurityMaintenanceEnv(base = {}, state = {}, now = Date.now()) {
  const env = { ...base };
  const normalized = normalizeLocalSecurityMaintenanceState(state, now);
  if (normalized.enabled) {
    env.FORGELINK_LOCAL_SECURITY_MAINTENANCE = "1";
    env.FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT = String(normalized.expiresAt);
    if (normalized.durationMs) env.FORGELINK_LOCAL_SECURITY_MAINTENANCE_DURATION_MS = String(normalized.durationMs);
  } else {
    delete env.FORGELINK_LOCAL_SECURITY_MAINTENANCE;
    delete env.FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT;
    delete env.FORGELINK_LOCAL_SECURITY_MAINTENANCE_DURATION_MS;
  }
  return env;
}
