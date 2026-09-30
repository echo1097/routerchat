import { api } from "../api.js";

export const DEFAULT_PROVIDER = {
  id: "openrouter",
  name: "OpenRouter",
  keyPlaceholder: "sk-or-v1-...",
  active: true,
  capabilities: {
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high", "max"],
    webSearch: true,
    pdfParsing: true,
    cost: true,
    structuredOutput: true,
    needsKey: true,
    needsBaseUrl: false,
    routingOptions: true,
  },
};

export const providerApi = {
  async listProviders() {
    const payload = await api("/api/providers");
    return {
      active: payload.active,
      providers: payload.providers || [],
    };
  },

  async getKeyStatus() {
    return api("/api/settings/key-status");
  },

  async saveKey(apiKey) {
    return api("/api/settings/openrouter-key", {
      method: "POST",
      body: JSON.stringify({ api_key: apiKey }),
    });
  },

  async listModels() {
    const payload = await api("/api/models");
    return payload.models || [];
  },
};
