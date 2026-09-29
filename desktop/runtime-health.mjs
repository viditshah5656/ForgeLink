export function deriveRuntimeState({ backendHealthy = false, liveConnections = 0, enabledConnections = 0 } = {}) {
  if (enabledConnections > 0 && backendHealthy && liveConnections === enabledConnections) {
    return { state: 'running', message: `${liveConnections}/${enabledConnections} ChatGPT tunnel connections live`, detail: 'MCP backend and all enabled tunnels are healthy.' };
  }
  if (liveConnections > 0 && backendHealthy) {
    return { state: 'degraded', message: `${liveConnections}/${enabledConnections} ChatGPT tunnel connections live`, detail: 'MCP backend is healthy; one or more enabled tunnels are not ready.' };
  }
  if (backendHealthy) {
    return { state: 'degraded', message: 'MCP backend is live; waiting for tunnel connections.', detail: `0/${enabledConnections} enabled tunnels are ready.` };
  }
  if (liveConnections > 0) {
    return { state: 'degraded', message: 'Tunnel connection detected; MCP backend is unavailable.', detail: 'The local execution endpoint is not healthy.' };
  }
  return { state: 'stopped', message: 'ForgeLink is not connected.', detail: 'MCP backend and enabled tunnel health checks are offline.' };
}
