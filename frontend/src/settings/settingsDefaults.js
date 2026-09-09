export const DEFAULT_MODEL = "anthropic/claude-3.5-sonnet";

export const newSettings = {
  model: DEFAULT_MODEL,
  temperature: 0.7,
  max_tokens: 30000,
  system_prompt: "",
  thinking_enabled: false,
  reasoning_effort: "medium",
  web_search_enabled: false,
  nitro_mode: false,
  lorebook_auto: false,
  lorebook_model: "",
};

export const LOREBOOK_MODEL_INHERIT = "";

export const CHAT_MODES = [
  { value: "chat", label: "Chat" },
  { value: "write", label: "Write" },
];
