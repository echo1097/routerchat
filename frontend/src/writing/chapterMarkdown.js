import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  ParagraphNode,
  TextNode,
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

export class SceneBreakNode extends ParagraphNode {
  static getType() {
    return "scene-break";
  }

  static clone(node) {
    return new SceneBreakNode(node.__key);
  }

  static importJSON(serializedNode) {
    return $createSceneBreakNode().updateFromJSON(serializedNode);
  }

  createDOM(config) {
    const dom = super.createDOM(config);
    const sceneBreakClass = config.theme && config.theme.sceneBreak;

    if (sceneBreakClass) {
      dom.classList.add(...String(sceneBreakClass).split(/\s+/).filter(Boolean));
    }

    return dom;
  }
}

export function $createSceneBreakNode() {
  return new SceneBreakNode();
}

export function $isSceneBreakNode(node) {
  return node instanceof SceneBreakNode;
}

function syncSceneBreakBlock(node) {
  if (!node.isAttached()) return;

  const looksLikeSceneBreak = isSceneBreakLine(node.getTextContent());

  if (looksLikeSceneBreak && !$isSceneBreakNode(node)) {
    node.replace($createSceneBreakNode(), true);
    return;
  }

  if (!looksLikeSceneBreak && $isSceneBreakNode(node)) {
    node.replace($createParagraphNode(), true);
  }
}

export function registerSceneBreakTransforms(editor) {
  const unregisterParagraph = editor.registerNodeTransform(ParagraphNode, syncSceneBreakBlock);
  const unregisterSceneBreak = editor.registerNodeTransform(SceneBreakNode, syncSceneBreakBlock);

  const unregisterText = editor.registerNodeTransform(TextNode, (node) => {
    const parent = node.getParent();

    if (parent instanceof ParagraphNode) {
      syncSceneBreakBlock(parent);
    }
  });

  return () => {
    unregisterParagraph();
    unregisterSceneBreak();
    unregisterText();
  };
}

//without this the exporter escapes a *** line into \*\*\*, which saves back to the server and stops the backend recognising the scene break at all
const SCENE_BREAK = {
  type: "element",
  dependencies: [SceneBreakNode],
  regExp: /^[*_-]{3,}\s*$/,
  export: (node) => {
    if (!$isParagraphNode(node)) return null;
    const text = node.getTextContent().trim();
    return isSceneBreakLine(text) ? text : null;
  },
  replace: (parentNode, children, match) => {
    const sceneBreak = $createSceneBreakNode();
    sceneBreak.append($createTextNode(match[0].trim()));
    parentNode.replace(sceneBreak);
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
