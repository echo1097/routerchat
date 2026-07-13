import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
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

export const chapterMarkdownTransformers = [
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
