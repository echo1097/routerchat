import { describe, expect, it } from "vitest";
import {
  chatRoute,
  isConversationPage,
  modeForPage,
  parseRoute,
  routePath,
} from "../../frontend/src/routing.js";

describe("conversation routes", () => {
  it("keeps chat and roleplay on separate paths", () => {
    expect(routePath(chatRoute({ id: "abc" }, "chat"))).toBe("/chat/abc");
    expect(routePath(chatRoute({ id: "abc" }, "roleplay"))).toBe("/roleplay/abc");
  });

  it("keeps temporary conversations on their own paths", () => {
    const temporary = { id: "abc", temporary: true };
    expect(routePath(chatRoute(temporary, "chat"))).toBe("/temp/abc");
    expect(routePath(chatRoute(temporary, "roleplay"))).toBe("/roleplay-temp/abc");
  });

  it("parses a roleplay path back into a roleplay route", () => {
    expect(parseRoute("/roleplay/abc", "")).toEqual({
      page: "roleplay",
      chatId: "abc",
    });
    expect(parseRoute("/roleplay-temp/abc", "")).toEqual({
      page: "roleplayTemp",
      chatId: "abc",
    });
  });

  it("round trips the home route for every mode", () => {
    for (const mode of ["chat", "roleplay", "write"]) {
      expect(routePath({ page: "home", mode })).toBe(`/?mode=${mode}`);
      expect(parseRoute("/", `?mode=${mode}`)).toEqual({ page: "home", mode });
    }
  });

  it("falls back to chat for an unknown mode", () => {
    expect(parseRoute("/", "?mode=nonsense")).toEqual({ page: "home", mode: "chat" });
  });

  it("maps pages back to the mode that owns them", () => {
    expect(modeForPage("chat")).toBe("chat");
    expect(modeForPage("temp")).toBe("chat");
    expect(modeForPage("roleplay")).toBe("roleplay");
    expect(modeForPage("roleplayTemp")).toBe("roleplay");
    expect(modeForPage("story")).toBe("write");
  });

  it("recognises only conversation pages", () => {
    expect(isConversationPage("roleplay")).toBe(true);
    expect(isConversationPage("story")).toBe(false);
    expect(isConversationPage("home")).toBe(false);
  });

  it("still routes stories", () => {
    expect(parseRoute("/write/story/s1/lorebook", "")).toEqual({
      page: "story",
      storyId: "s1",
      chapterId: null,
      workspaceView: "lorebook",
    });
  });
});
