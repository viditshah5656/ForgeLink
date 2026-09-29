/**
 * ForgeLink deliberately does not host or call a model provider by default.
 * ChatGPT Web is the reasoning host and drives workers through MCP handoffs.
 * This registry remains as an extension point for explicitly installed
 * provider adapters (for example the optional local Codex CLI adapter).
 */
export class ModelProviderRegistry {
  constructor({ providers = [] } = {}) {
    this.providers = new Map();
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    if (!provider || typeof provider.id !== 'string' || typeof provider.generate !== 'function' || typeof provider.discover !== 'function') {
      throw new TypeError('Provider requires id, discover(), and generate()');
    }
    if (this.providers.has(provider.id)) throw new Error(`Model provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
    return provider;
  }

  get(id) { return this.providers.get(id); }

  async list({ signal } = {}) {
    return await Promise.all([...this.providers.values()].map((provider) => provider.discover({ signal })));
  }

  async resolve(id, { signal } = {}) {
    const normalized = ['auto', 'native', 'local'].includes(id) ? 'chatgpt_web' : id;
    const provider = this.providers.get(normalized);
    if (!provider) return { provider: null, status: 'waiting_for_provider', reason: `No backend model provider is configured for ${normalized}. Use the ChatGPT Web MCP handoff.` };
    const state = await provider.discover({ signal });
    if (!state.available) return { provider, status: 'waiting_for_provider', reason: state.reason };
    return { provider, status: 'available', models: state.models || [] };
  }
}

export const defaultModelProviderRegistry = new ModelProviderRegistry();
