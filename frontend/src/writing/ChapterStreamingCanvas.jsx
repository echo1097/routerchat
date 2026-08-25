import React, { useRef } from "react";
import ReactMarkdown from "react-markdown";

import { streamWordsPlugin, useStreamReveal } from "../streamingText.js";

//lexical rebuilds its whole tree from markdown on every chunk, so word spans cannot survive inside the
//editor, this stands in while a chapter streams and hands the canvas back once the run finishes
export default function ChapterStreamingCanvas({ markdown }) {
  const bodyRef = useRef(null);
  const settledRef = useRef(0);
  const { text: visibleMarkdown, revealing } = useStreamReveal(
    bodyRef,
    true,
    markdown || "",
    settledRef,
  );

  const rehypePlugins = revealing ? [streamWordsPlugin(settledRef)] : undefined;

  return (
    <div ref={bodyRef} className="chapter-stream" aria-live="polite" aria-busy="true">
      <ReactMarkdown rehypePlugins={rehypePlugins}>{visibleMarkdown}</ReactMarkdown>
    </div>
  );
}
