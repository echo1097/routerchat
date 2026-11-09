import { describe, expect, it, vi } from "vitest";

import { buildMenuItems } from "../../../electron/window/contextMenuItems.js";

const allEditFlags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

function makeActions() {
  return { replaceWord: vi.fn(), addToDictionary: vi.fn() };
}

function readLabels(menuItems) {
  return menuItems.map((item) => item.label || item.role || item.type);
}

describe("buildMenuItems", () => {
  it("lists spelling suggestions above the edit items for a misspelled word", () => {
    const menuItems = buildMenuItems(
      {
        isEditable: true,
        misspelledWord: "speling",
        dictionarySuggestions: ["spelling", "spieling"],
        editFlags: allEditFlags,
      },
      makeActions(),
    );

    expect(readLabels(menuItems)).toEqual([
      "spelling",
      "spieling",
      "separator",
      "Add to Dictionary",
      "separator",
      "cut",
      "copy",
      "paste",
      "separator",
      "selectAll",
    ]);
  });

  it("replaces the word with the chosen suggestion", () => {
    const actions = makeActions();
    const menuItems = buildMenuItems(
      { isEditable: true, misspelledWord: "speling", dictionarySuggestions: ["spelling"], editFlags: allEditFlags },
      actions,
    );

    menuItems[0].click();

    expect(actions.replaceWord).toHaveBeenCalledWith("spelling");
    expect(actions.addToDictionary).not.toHaveBeenCalled();
  });

  it("adds the misspelled word to the dictionary", () => {
    const actions = makeActions();
    const menuItems = buildMenuItems(
      { isEditable: true, misspelledWord: "routerchat", dictionarySuggestions: [], editFlags: allEditFlags },
      actions,
    );

    menuItems.find((item) => item.label === "Add to Dictionary").click();

    expect(actions.addToDictionary).toHaveBeenCalledWith("routerchat");
  });

  it("says so when a misspelled word has no suggestions", () => {
    const menuItems = buildMenuItems(
      { isEditable: true, misspelledWord: "xqzv", dictionarySuggestions: [], editFlags: allEditFlags },
      makeActions(),
    );

    expect(menuItems[0]).toEqual({ label: "No suggestions", enabled: false });
  });

  it("shows only the edit items in a text field with no misspelling", () => {
    const menuItems = buildMenuItems(
      { isEditable: true, misspelledWord: "", editFlags: { canPaste: true, canSelectAll: true } },
      makeActions(),
    );

    expect(menuItems).toEqual([
      { role: "cut", enabled: false },
      { role: "copy", enabled: false },
      { role: "paste", enabled: true },
      { type: "separator" },
      { role: "selectAll", enabled: true },
    ]);
  });

  it("offers copy for selected text outside a text field", () => {
    const menuItems = buildMenuItems({ isEditable: false, selectionText: "some reply text" }, makeActions());

    expect(menuItems).toEqual([{ role: "copy" }]);
  });

  it("shows nothing when there is nothing to act on", () => {
    expect(buildMenuItems({ isEditable: false, selectionText: "   " }, makeActions())).toEqual([]);
  });
});
