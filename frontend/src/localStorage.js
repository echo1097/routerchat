import openingMessages from "./openingMessages.json";

const APP_SETTINGS_STORAGE_KEY = "routerchat.appSettings";

const CHAT_FOLDERS_STORAGE_KEY = "routerchat.chatFolders";

const OPENING_MESSAGE_STORAGE_KEY = "routerchat.lastOpeningMessage";

export const PENDING_CHAPTER_DRAFTS_STORAGE_KEY = "routerchat.pendingChapterDrafts";

export function pickOpeningMessage(mode = "chat") {
  const runTime = new Date().getHours();
  const timeKey =
    runTime >= 22 || runTime < 5
      ? "lateNight"
      : runTime < 12
        ? "morning"
        : runTime < 17
          ? "afternoon"
          : "evening";

  const messageSet = openingMessages[mode] || openingMessages.chat || openingMessages;
  const timeMessages = Array.isArray(messageSet[timeKey]) ? messageSet[timeKey] : [];
  const messages = timeMessages.filter((message) => typeof message === "string" && message.trim());
  if (messages.length === 0) return "Where should we begin?";

  const lastMessage =
    typeof window !== "undefined"
      ? window.localStorage.getItem(`${OPENING_MESSAGE_STORAGE_KEY}.${mode}`)
      : null;
  const choices = messages.length > 1 ? messages.filter((message) => message !== lastMessage) : messages;
  const nextMessage = choices[Math.floor(Math.random() * choices.length)];

  if (typeof window !== "undefined") {
    window.localStorage.setItem(`${OPENING_MESSAGE_STORAGE_KEY}.${mode}`, nextMessage);
  }

  return nextMessage;
}

export function readLocalAppSettings() {
  try {
    return JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function writeLocalAppSettings(next) {
  const merged = { ...readLocalAppSettings(), ...next };
  window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(merged));
}

export function readLocalChatFolders() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(CHAT_FOLDERS_STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((folder) => folder && folder.id && typeof folder.name === "string");
  } catch {
    return [];
  }
}

export function clearLocalChatFolders() {
  window.localStorage.removeItem(CHAT_FOLDERS_STORAGE_KEY);
}
