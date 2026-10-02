import { DEFAULT_PROVIDER } from "./providerApi.js";

const PREVIEW_CAPABILITIES = {
  ...DEFAULT_PROVIDER.capabilities,
  routingOptions: false,
};

const ANTHROPIC_CAPABILITIES = {
  ...DEFAULT_PROVIDER.capabilities,
  webSearch: false,
  routingOptions: false,
  transcription: false,
  freeModels: false,
  maxImageBytes: 5 * 1024 * 1024,
};

export const PROVIDER_OPTIONS = [
  {
    id: DEFAULT_PROVIDER.id,
    name: DEFAULT_PROVIDER.name,
    tabLabel: "OpenRouter",
    keyPlaceholder: DEFAULT_PROVIDER.keyPlaceholder,
    capabilities: DEFAULT_PROVIDER.capabilities,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    tabLabel: "Anthropic",
    keyPlaceholder: "sk-ant-...",
    capabilities: ANTHROPIC_CAPABILITIES,
  },
  {
    id: "openai",
    name: "OpenAI",
    tabLabel: "OpenAI",
    keyPlaceholder: "sk-...",
    preview: true,
    capabilities: PREVIEW_CAPABILITIES,
  },
  {
    id: "local",
    name: "Local model",
    tabLabel: "Local",
    keyPlaceholder: "Optional",
    baseUrlPlaceholder: "http://localhost:11434/v1",
    preview: true,
    capabilities: {
      ...PREVIEW_CAPABILITIES,
      needsKey: false,
      needsBaseUrl: true,
      cost: false,
      webSearch: false,
    },
  },
];

export function findProviderOption(providerId) {
  return PROVIDER_OPTIONS.find((option) => option.id === providerId) || PROVIDER_OPTIONS[0];
}
