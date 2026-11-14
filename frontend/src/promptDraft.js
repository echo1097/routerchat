const PROMPT_DRAFT_STORAGE_KEY = "routerchat.promptDraft";

function draftStorage() {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function readPromptDraft() {
  try {
    return draftStorage()?.getItem(PROMPT_DRAFT_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function savePromptDraft(text) {
  try {
    const storage = draftStorage();
    if (!storage) return;

    if (text) {
      storage.setItem(PROMPT_DRAFT_STORAGE_KEY, text);
    } else {
      storage.removeItem(PROMPT_DRAFT_STORAGE_KEY);
    }
  } catch {
    return;
  }
}
