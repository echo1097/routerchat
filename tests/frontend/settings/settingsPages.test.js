import { describe, expect, it } from "vitest";

import {
  SETTINGS_PAGES,
  groupPages,
  pageVisibleInMode,
  searchSettings,
} from "../../../frontend/src/settings/settingsPages.js";

const chatPages = SETTINGS_PAGES.filter((page) => pageVisibleInMode(page, "chat"));
const writePages = SETTINGS_PAGES.filter((page) => pageVisibleInMode(page, "write"));


describe("searchSettings", () => {
  it("returns nothing for an empty query", () => {
    expect(searchSettings("   ", { pages: chatPages })).toEqual([]);
  });

  it("finds a setting by title and names its page", () => {
    const results = searchSettings("temp", { pages: chatPages });

    expect(results.map((result) => result.title)).toEqual(["Temperature"]);
    expect(results[0].pageLabel).toBe("Generation");
    expect(results[0].target).toBe("settings-group-output");
  });

  it("matches keywords", () => {
    const titles = searchSettings("thinking", { pages: chatPages }).map((result) => result.title);

    expect(titles).toContain("Reasoning effort");
  });

  it("hides settings from pages that are not shown in this mode", () => {
    expect(searchSettings("system prompt", { pages: writePages })).toEqual([]);
    expect(searchSettings("lorebook", { pages: chatPages })).toEqual([]);
  });

  it("hides settings the provider does not support", () => {
    expect(searchSettings("turbo", { pages: chatPages, capabilities: {} })).toEqual([]);
    expect(searchSettings("turbo", { pages: chatPages, capabilities: { routingOptions: true } })).toHaveLength(1);
  });
});


describe("phone access", () => {
  it("has its own page that is marked as computer only", () => {
    const page = SETTINGS_PAGES.find((entry) => entry.id === "phone");

    expect(page.label).toBe("Phone");
    expect(page.computerOnly).toBe(true);
  });

  it("is found by search and points at the phone page", () => {
    const results = searchSettings("pair", { pages: chatPages });

    expect(results.map((result) => result.title)).toEqual(["Phone access"]);
    expect(results[0].pageLabel).toBe("Phone");
  });

  it("is not found once the phone page is hidden", () => {
    const pages = chatPages.filter((page) => !page.computerOnly);

    expect(searchSettings("pair", { pages })).toEqual([]);
  });
});


describe("groupPages", () => {
  it("keeps pages in order under their group labels", () => {
    const groups = groupPages(chatPages);

    expect(groups.map((group) => group.label)).toEqual(["Models", "App", "Data"]);
    expect(groups[1].pages.map((page) => page.id)).toEqual(["chat", "voice", "interface", "phone"]);
  });
});
