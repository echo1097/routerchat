import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { createEditor } from "lexical";
import { describe, expect, it } from "vitest";
import {
  exportChapterMarkdown,
  importChapterMarkdown,
} from "../../../frontend/src/writing/chapterMarkdown.js";

function migrateMarkdown(markdown) {
  const editor = createEditor({
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode],
  });
  let importError = null;

  editor.update(() => {
    importError = importChapterMarkdown(markdown);
  }, { discrete: true });

  let exportedMarkdown = "";
  editor.getEditorState().read(() => {
    exportedMarkdown = exportChapterMarkdown();
  });

  return { exportedMarkdown, importError };
}

describe("chapter Markdown compatibility", () => {
  it("round trips the formatting used by existing stories", () => {
    const legacyMarkdown = [
      "# The Tower",
      "",
      "A **bold** choice and an _uncertain_ answer with `quiet code`.",
      "",
      "1. First step",
      "    - Nested warning",
      "",
      "> Keep climbing.",
      "",
      "```text",
      "the old inscription",
      "```",
      "",
      "[Read the map](https://example.com/map)",
    ].join("\n");

    const result = migrateMarkdown(legacyMarkdown);
    const normalizedResult = migrateMarkdown(result.exportedMarkdown);

    expect(result.importError).toBeNull();
    expect(result.exportedMarkdown).toContain("# The Tower");
    expect(result.exportedMarkdown).toContain("**bold**");
    expect(result.exportedMarkdown).toContain("*uncertain*");
    expect(result.exportedMarkdown).toContain("    - Nested warning");
    expect(result.exportedMarkdown).toContain("```text\nthe old inscription\n```");
    expect(normalizedResult.exportedMarkdown).toBe(result.exportedMarkdown);
  });

  it("keeps unsupported and malformed Markdown as literal text", () => {
    const legacyMarkdown = [
      "| unsupported | table |",
      "| --- | --- |",
      "",
      "[unfinished link",
      "",
      "emoji 🐉 — café",
    ].join("\n");

    const result = migrateMarkdown(legacyMarkdown);

    expect(result.importError).toBeNull();
    expect(result.exportedMarkdown).toContain("| unsupported | table |");
    expect(result.exportedMarkdown).toContain("[unfinished link");
    expect(result.exportedMarkdown).toContain("emoji 🐉 — café");
  });

  it("normalizes legacy line endings only when exported after editing", () => {
    const result = migrateMarkdown("first\r\n\r\nsecond");

    expect(result.importError).toBeNull();
    expect(result.exportedMarkdown).toBe("first\n\nsecond");
  });
});
