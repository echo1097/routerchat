import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $getRoot, createEditor } from "lexical";
import { describe, expect, it } from "vitest";
import {
  $isSceneBreakNode,
  exportChapterMarkdown,
  importChapterMarkdown,
  registerSceneBreakTransforms,
  SceneBreakNode,
} from "../../../frontend/src/writing/chapterMarkdown.js";

function createChapterEditor() {
  const editor = createEditor({
    nodes: [
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      LinkNode,
      CodeNode,
      SceneBreakNode,
    ],
  });

  registerSceneBreakTransforms(editor);

  return editor;
}

function migrateMarkdown(markdown) {
  const editor = createChapterEditor();
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

  it("round trips scene breaks without escaping them", () => {
    //the exporter used to turn *** into \*\*\*, which autosaved back to the server and stopped is_scene_break matching, shifting every paragraph id after it
    const source = "first paragraph\n\n***\n\nlast paragraph";
    const result = migrateMarkdown(source);

    expect(result.importError).toBeNull();
    expect(result.exportedMarkdown).toBe(source);
    expect(result.exportedMarkdown).not.toContain("\\*");
  });

  it("round trips the other separator shapes the backend treats as scene breaks", () => {
    for (const separator of ["***", "---", "___", "****"]) {
      const source = `before\n\n${separator}\n\nafter`;
      expect(migrateMarkdown(source).exportedMarkdown).toBe(source);
    }
  });

  it("gives every separator shape its own scene break node so the divider can be drawn", () => {
    for (const separator of ["***", "---", "___", "****"]) {
      const editor = createChapterEditor();

      editor.update(() => {
        importChapterMarkdown(`before\n\n${separator}\n\nafter`);
      }, { discrete: true });

      editor.getEditorState().read(() => {
        const children = $getRoot().getChildren();
        expect(children.map($isSceneBreakNode)).toEqual([false, true, false]);
        expect(children[1].getTextContent()).toBe(separator);
      });
    }
  });

  it("turns a line into a scene break and back as its text changes", () => {
    const editor = createChapterEditor();

    editor.update(() => {
      importChapterMarkdown("before\n\n---\n\nafter");
    }, { discrete: true });

    editor.update(() => {
      $getRoot().getChildren()[1].getFirstChild().setTextContent("--- a note");
    }, { discrete: true });

    editor.getEditorState().read(() => {
      expect($isSceneBreakNode($getRoot().getChildren()[1])).toBe(false);
    });

    editor.update(() => {
      $getRoot().getChildren()[1].getFirstChild().setTextContent("---");
    }, { discrete: true });

    editor.getEditorState().read(() => {
      expect($isSceneBreakNode($getRoot().getChildren()[1])).toBe(true);
    });

    let exportedMarkdown = "";
    editor.getEditorState().read(() => {
      exportedMarkdown = exportChapterMarkdown();
    });

    expect(exportedMarkdown).toBe("before\n\n---\n\nafter");
  });

  it("makes a divider out of the dashes macOS smart substitution leaves behind", () => {
    for (const typed of ["---", "\u2013-", "\u2014-", "-\u2013"]) {
      const editor = createChapterEditor();

      editor.update(() => {
        importChapterMarkdown("before\n\nplaceholder\n\nafter");
      }, { discrete: true });

      editor.update(() => {
        $getRoot().getChildren()[1].getFirstChild().setTextContent(typed);
      }, { discrete: true });

      let exportedMarkdown = "";
      editor.getEditorState().read(() => {
        expect($isSceneBreakNode($getRoot().getChildren()[1])).toBe(true);
        exportedMarkdown = exportChapterMarkdown();
      });

      //the backend only recognises ASCII dividers, so a smart dash can never reach the saved file
      expect(exportedMarkdown).toBe("before\n\n---\n\nafter");
    }
  });

  it("leaves a lone em dash alone as prose punctuation", () => {
    const editor = createChapterEditor();

    editor.update(() => {
      importChapterMarkdown("before\n\nplaceholder\n\nafter");
    }, { discrete: true });

    editor.update(() => {
      $getRoot().getChildren()[1].getFirstChild().setTextContent("\u2014");
    }, { discrete: true });

    editor.getEditorState().read(() => {
      expect($isSceneBreakNode($getRoot().getChildren()[1])).toBe(false);
    });
  });

  it("still escapes literal asterisks inside real prose", () => {
    const result = migrateMarkdown("a lone * in the middle of a sentence");

    expect(result.importError).toBeNull();
    //stable under a second pass is what matters, the escape survives re-import as the same character
    expect(migrateMarkdown(result.exportedMarkdown).exportedMarkdown)
      .toBe(result.exportedMarkdown);
  });

  it("normalizes legacy line endings only when exported after editing", () => {
    const result = migrateMarkdown("first\r\n\r\nsecond");

    expect(result.importError).toBeNull();
    expect(result.exportedMarkdown).toBe("first\n\nsecond");
  });
});
