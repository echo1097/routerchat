import { useCallback, useEffect, useMemo, useRef } from "react";
import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { CLEAR_HISTORY_COMMAND } from "lexical";
import {
  chapterMarkdownTransformers,
  exportChapterMarkdown,
  importChapterMarkdown,
} from "./chapterMarkdown.js";

const EXTERNAL_MARKDOWN_TAG = "chapter-markdown-external";

const editorTheme = {
  code: "chapter-editor-code-block",
  heading: {
    h1: "chapter-editor-heading chapter-editor-heading-h1",
    h2: "chapter-editor-heading chapter-editor-heading-h2",
    h3: "chapter-editor-heading chapter-editor-heading-h3",
    h4: "chapter-editor-heading chapter-editor-heading-h4",
    h5: "chapter-editor-heading chapter-editor-heading-h5",
    h6: "chapter-editor-heading chapter-editor-heading-h6",
  },
  link: "chapter-editor-link",
  list: {
    listitem: "chapter-editor-list-item",
    nested: {
      listitem: "chapter-editor-list-item-nested",
    },
    ol: "chapter-editor-list chapter-editor-list-ordered",
    ul: "chapter-editor-list chapter-editor-list-unordered",
  },
  paragraph: "chapter-editor-paragraph",
  quote: "chapter-editor-quote",
  text: {
    bold: "chapter-editor-bold",
    code: "chapter-editor-inline-code",
    italic: "chapter-editor-italic",
  },
};

function MarkdownSyncPlugin({ markdown, readOnly, onImportFallback, sourceMarkdownRef }) {
  const [editor] = useLexicalComposerContext();
  const appliedMarkdownRef = useRef(markdown);

  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (markdown === appliedMarkdownRef.current) return;

    if (markdown === sourceMarkdownRef.current) {
      appliedMarkdownRef.current = markdown;
      return;
    }

    let importError = null;
    editor.update(
      () => {
        importError = importChapterMarkdown(markdown);
      },
      {
        discrete: true,
        tag: EXTERNAL_MARKDOWN_TAG,
      },
    );
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);

    appliedMarkdownRef.current = markdown;
    sourceMarkdownRef.current = markdown;
    if (importError) onImportFallback?.(importError);
  }, [editor, markdown, onImportFallback, sourceMarkdownRef]);

  return null;
}

export default function ChapterCanvasEditor({
  chapterId,
  markdown,
  readOnly,
  placeholder,
  onChange,
  onImportFallback,
}) {
  const sourceMarkdownRef = useRef(markdown);
  const initialImportErrorRef = useRef(null);
  const editorReadyRef = useRef(false);

  const initialConfig = useMemo(
    () => ({
      editable: !readOnly,
      editorState: () => {
        initialImportErrorRef.current = importChapterMarkdown(markdown);
      },
      namespace: `ChapterCanvas-${chapterId}`,
      nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode],
      onError(error) {
        onImportFallback?.(error);
      },
      theme: editorTheme,
    }),
    [],
  );

  useEffect(() => {
    if (initialImportErrorRef.current) {
      onImportFallback?.(initialImportErrorRef.current);
      initialImportErrorRef.current = null;
    }
  }, [onImportFallback]);

  useEffect(() => {
    const readyFrame = requestAnimationFrame(() => {
      editorReadyRef.current = true;
    });

    return () => cancelAnimationFrame(readyFrame);
  }, []);

  const handleChange = useCallback(
    (editorState, editor, tags) => {
      if (tags.has(EXTERNAL_MARKDOWN_TAG)) return;
      if (!editorReadyRef.current) return;

      let nextMarkdown = "";
      editorState.read(() => {
        nextMarkdown = exportChapterMarkdown();
      });

      if (nextMarkdown === sourceMarkdownRef.current) return;
      sourceMarkdownRef.current = nextMarkdown;
      onChange(nextMarkdown);
    },
    [onChange],
  );

  const keepLinkClickInEditor = useCallback((event) => {
    if (event.target instanceof Element && event.target.closest("a")) {
      event.preventDefault();
    }
  }, []);

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="chapter-editor-shell">
        <RichTextPlugin
          contentEditable={(
            <ContentEditable
              aria-label="Chapter canvas"
              aria-multiline="true"
              aria-readonly={readOnly}
              className="chapter-editor-content"
              onClick={keepLinkClickInEditor}
              spellCheck="true"
            />
          )}
          placeholder={<div className="chapter-editor-placeholder">{placeholder}</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin attributes={{ rel: "noreferrer", target: "_blank" }} />
        <MarkdownShortcutPlugin transformers={chapterMarkdownTransformers} />
        <OnChangePlugin
          ignoreHistoryMergeTagChange={false}
          ignoreSelectionChange
          onChange={handleChange}
        />
        <MarkdownSyncPlugin
          markdown={markdown}
          readOnly={readOnly}
          onImportFallback={onImportFallback}
          sourceMarkdownRef={sourceMarkdownRef}
        />
      </div>
    </LexicalComposer>
  );
}
