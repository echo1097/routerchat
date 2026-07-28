import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
} from "lexical";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  CODE,
  HEADING,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  ORDERED_LIST,
  QUOTE,
  UNORDERED_LIST,
} from "@lexical/markdown";

//mirrors is_scene_break in backend/writing.py, the two have to agree or a scene break stops being its own block
const SCENE_BREAK_PATTERN = /^[*_-]{3,}$/;

export function isSceneBreakLine(value) {
  return SCENE_BREAK_PATTERN.test(String(value || "").trim());
}

//without this the exporter escapes a *** line into \*\*\*, which saves back to the server and stops the backend recognising the scene break at all
const SCENE_BREAK = {
  type: "element",
  dependencies: [],
  regExp: /^[*_-]{3,}\s*$/,
  export: (node) => {
    if (!$isParagraphNode(node)) return null;
    const text = node.getTextContent().trim();
    return isSceneBreakLine(text) ? text : null;
  },
  replace: (parentNode, children, match) => {
    const paragraph = $createParagraphNode();
    paragraph.append($createTextNode(match[0].trim()));
    parentNode.replace(paragraph);
  },
};

export const chapterMarkdownTransformers = [
  SCENE_BREAK,
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  INLINE_CODE,
  LINK,
];

function importLiteralMarkdown(markdown) {
  const root = $getRoot();
  root.clear();

  const paragraph = $createParagraphNode();
  const lines = String(markdown || "").split(/\r?\n/);

  lines.forEach((line, index) => {
    if (index > 0) paragraph.append($createLineBreakNode());
    if (line) paragraph.append($createTextNode(line));
  });

  root.append(paragraph);
}

export function importChapterMarkdown(markdown) {
  const sourceMarkdown = String(markdown || "");
  const editorMarkdown = sourceMarkdown.replace(/\r\n?/g, "\n");

  try {
    $convertFromMarkdownString(editorMarkdown, chapterMarkdownTransformers);

    const root = $getRoot();
    if (sourceMarkdown && root.getChildrenSize() === 0) {
      throw new Error("Markdown import produced an empty document");
    }

    return null;
  } catch (error) {
    importLiteralMarkdown(sourceMarkdown);
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function exportChapterMarkdown() {
  return $convertToMarkdownString(chapterMarkdownTransformers);
}
