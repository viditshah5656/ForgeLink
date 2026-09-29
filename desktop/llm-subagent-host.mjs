/**
 * A host runs model cognition. ForgeLink only supplies scoped execution tools.
 * ChatGPT's MCP client currently exposes tool calls, not an API for an MCP
 * server to create an independent ChatGPT conversation or set its model.
 */
export class ChatGPTWebHost {
  constructor() { this.id = 'chatgpt_web'; }

  capabilities() {
    return {
      provider: this.id,
      executionMode: 'coordinator_handoff',
      independentContexts: false,
      dynamicSpawn: false,
      nestedSpawn: false,
      parallel: false,
      nativeClientSubagents: 'client_owned_unverified',
      nativeSpawnByMcp: false,
      parallelAssignments: true,
      parallelLLMExecution: 'host_dependent',
      toolCalling: true,
      workspaceIsolation: true,
      reasoningControl: 'unsupported_by_host',
      reasoningConfiguration: 'not_exposed',
      reasoningPassthrough: 'host_owned_unverified',
      modelSelection: 'unsupported_by_host',
      streaming: false,
      resumePacket: true,
    };
  }

  validateRequest({ model, reasoning } = {}) {
    if (model) throw new Error('ChatGPT Web MCP does not expose model selection for worker assignments');
    if (reasoning?.mode && reasoning.mode !== 'default' || reasoning?.effort) {
      throw new Error('ChatGPT Web MCP does not expose reasoning control for worker assignments');
    }
  }
}

/**
 * An actual host bridge may implement this contract when the host exposes one.
 * The returned session must own an independent model context and its MCP tool
 * authorization. A coordinator handoff must never advertise this capability.
 */
export function assertIndependentHost(host) {
  if (!host || typeof host.capabilities !== 'function' || typeof host.createSubagent !== 'function' ||
      typeof host.waitForSubagent !== 'function' || typeof host.cancelSubagent !== 'function') {
    throw new TypeError('Independent LLM host requires capabilities(), createSubagent(), waitForSubagent(), and cancelSubagent()');
  }
  if (host.capabilities().independentContexts !== true) throw new Error('Host cannot create independent LLM contexts');
  return host;
}
