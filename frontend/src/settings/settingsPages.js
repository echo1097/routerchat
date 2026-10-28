import {
  Activity,
  Database,
  Layers,
  MessageSquare,
  Mic,
  Network,
  PenLine,
  SlidersHorizontal,
} from "lucide-react";

export const SETTINGS_PAGES = [
  { id: "provider", label: "Provider", icon: Network, group: "Models" },
  { id: "models", label: "Models", icon: Layers, group: "Models" },
  { id: "generation", label: "Generation", icon: SlidersHorizontal, group: "Models" },
  { id: "chat", label: "Chat", icon: MessageSquare, group: "App", mode: "chat" },
  { id: "writing", label: "Writing", icon: PenLine, group: "App", mode: "write" },
  { id: "voice", label: "Dictation", icon: Mic, group: "App" },
  { id: "interface", label: "Interface", iconSrc: "/icons/interface.png", group: "App" },
  { id: "data", label: "Data", icon: Database, group: "Data" },
  { id: "usage", label: "Usage", icon: Activity, group: "Data" },
];

export const SETTINGS_SEARCH_INDEX = [
  { title: "Provider", page: "provider", target: "settings-group-account", keywords: "openrouter anthropic" },
  { title: "API key", page: "provider", target: "settings-group-account", keywords: "key save" },
  { title: "Disable prompt caching", page: "provider", target: "settings-group-caching", keywords: "cache" },
  { title: "Keep cache for 1 hour", page: "provider", target: "settings-group-caching", keywords: "cache" },
  { title: "Turbo", page: "provider", target: "settings-group-routing", keywords: "fast routing nitro", requires: "routingOptions" },
  { title: "Cheapest first", page: "provider", target: "settings-group-routing", keywords: "price routing", requires: "routingOptions" },
  { title: "Privacy mode", page: "provider", target: "settings-group-privacy", keywords: "training", requires: "routingOptions" },
  { title: "Zero data retention", page: "provider", target: "settings-group-privacy", keywords: "zdr privacy", requires: "routingOptions" },
  { title: "Default model", page: "models", target: "settings-group-current-model", keywords: "current model" },
  { title: "Hide free models", page: "models", target: "settings-group-model-filters", keywords: "model picker list", requires: "freeModels" },
  { title: "Hide batch models", page: "models", target: "settings-group-model-filters", keywords: "model picker list" },
  { title: "Reasoning effort", page: "generation", target: "settings-group-reasoning", keywords: "thinking" },
  { title: "Temperature", page: "generation", target: "settings-group-output", keywords: "creative" },
  { title: "Max output tokens", page: "generation", target: "settings-group-output", keywords: "length" },
  { title: "System prompt", page: "chat", target: "settings-group-system-prompt", keywords: "instructions" },
  { title: "Generate chat name", page: "chat", target: "settings-group-chats", keywords: "title" },
  { title: "Retry skipped edits", page: "writing", target: "settings-group-lorebook", keywords: "lorebook" },
  { title: "Lorebook model", page: "writing", target: "", keywords: "lorebook" },
  { title: "Dictation model", page: "voice", target: "", keywords: "transcription voice typing" },
  { title: "Navigation bar", page: "interface", target: "settings-group-display", keywords: "display" },
  { title: "Smooth text", page: "interface", target: "settings-group-display", keywords: "streaming display" },
  { title: "Check for updates", page: "interface", target: "settings-group-updates", keywords: "version" },
  { title: "Export or import a chat", page: "data", target: "settings-group-transfer", keywords: "backup download upload" },
  { title: "Usage", page: "usage", target: "", keywords: "cost spend tokens" },
];


export function pageVisibleInMode(page, chatMode) {
  if (page.mode === "write") return chatMode === "write";
  if (page.mode === "chat") return chatMode !== "write";
  return true;
}


export function groupPages(pages) {
  const groups = [];

  for (const page of pages) {
    const group = groups.find((entry) => entry.label === page.group);
    if (group) {
      group.pages.push(page);
    } else {
      groups.push({ label: page.group, pages: [page] });
    }
  }

  return groups;
}


export function searchSettings(query, { pages, capabilities = {} }) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const visiblePageIds = new Set(pages.map((page) => page.id));

  return SETTINGS_SEARCH_INDEX
    .filter((entry) => visiblePageIds.has(entry.page))
    .filter((entry) => !entry.requires || capabilities[entry.requires])
    .filter((entry) => {
      const pageLabel = pages.find((page) => page.id === entry.page)?.label || "";
      const haystack = `${entry.title} ${entry.keywords || ""} ${pageLabel}`.toLowerCase();
      return haystack.includes(normalized);
    })
    .map((entry) => ({
      ...entry,
      pageLabel: pages.find((page) => page.id === entry.page)?.label || "",
    }));
}
