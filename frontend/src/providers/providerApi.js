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
    transcription: true,
    freeModels: true,
    maxImageBytes: null,
    maxRequestAttachmentBytes: null,
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

  async setActiveProvider(providerId) {
    const payload = await api("/api/providers/active", {
      method: "POST",
      body: JSON.stringify({ id: providerId }),
    });
    return {
      active: payload.active,
      providers: payload.providers || [],
    };
  },

  async saveKey(providerId, apiKey) {
    return api(`/api/providers/${encodeURIComponent(providerId)}/key`, {
      method: "POST",
      body: JSON.stringify({ api_key: apiKey }),
    });
  },

  async listModels(providerId) {
    const query = providerId ? `?provider=${encodeURIComponent(providerId)}` : "";
    const payload = await api(`/api/models${query}`);
    return payload.models || [];
  },
};
