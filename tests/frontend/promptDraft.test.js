import { afterEach, describe, expect, it, vi } from "vitest";

import { readPromptDraft, savePromptDraft } from "../../frontend/src/promptDraft.js";

function fakeStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
    size: () => items.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prompt draft", () => {
  it("gives back what was typed after the page starts over", () => {
    vi.stubGlobal("window", { sessionStorage: fakeStorage() });

    savePromptDraft("rewrite the second paragraph");

    expect(readPromptDraft()).toBe("rewrite the second paragraph");
  });

  it("forgets the draft once the prompt box is empty", () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { sessionStorage: storage });

    savePromptDraft("half a thought");
    savePromptDraft("");

    expect(readPromptDraft()).toBe("");
    expect(storage.size()).toBe(0);
  });

  it("stays quiet when the browser blocks storage", () => {
    vi.stubGlobal("window", {
      get sessionStorage() {
        throw new Error("blocked");
      },
    });

    expect(() => savePromptDraft("anything")).not.toThrow();
    expect(readPromptDraft()).toBe("");
  });

  it("starts empty when there is no browser at all", () => {
    expect(readPromptDraft()).toBe("");
  });
});
