import ReactMarkdown from "react-markdown";

import { MARKDOWN_IMAGE_COMPONENT } from "./markdownImage.jsx";

function formatThinkingMarkdown(value) {
  return (value || "")
    .replace(/([^\n])\s+(\d+\.\s+)/g, "$1\n$2")
    .replace(/:\n(\d+\.\s+)/g, ":\n\n$1");
}

// a list nested inside a list gets the full 12px block margin otherwise, which reads as a gap
const NESTED_LIST_SPACING = "[&_ul]:my-1 [&_ol]:my-1";

// headings inside a thinking box only need two weights, models nest way deeper than that but nobody
// wants an h6 in a 200px scroll pane
function ThinkingHeading({ node, ...props }) {
  return <h3 className="mb-2 mt-4 text-[1.04em] font-semibold text-neutral-300 first:mt-0" {...props} />;
}

function ThinkingSubheading({ node, ...props }) {
  return (
    <h4
      className="mb-1.5 mt-3 text-[0.95em] font-semibold uppercase tracking-wide text-neutral-400 first:mt-0"
      {...props}
    />
  );
}

// Module scope on purpose: inline components would be new element types on every render, so
// streamed reasoning would tear down and rebuild this whole subtree on each token.
const THINKING_MARKDOWN_COMPONENTS = {
  ...MARKDOWN_IMAGE_COMPONENT,
  p: ({ node, ...props }) => <p className="mb-3 text-pretty last:mb-0" {...props} />,
  h1: ThinkingHeading,
  h2: ThinkingHeading,
  h3: ThinkingHeading,
  h4: ThinkingSubheading,
  h5: ThinkingSubheading,
  h6: ThinkingSubheading,
  strong: ({ node, ...props }) => <strong className="font-semibold text-neutral-300" {...props} />,
  a: ({ node, ...props }) => (
    <a
      className="text-neutral-300 underline decoration-white/25 underline-offset-2 hover:decoration-white/60"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  blockquote: ({ node, ...props }) => (
    <blockquote className="my-3 border-l-2 border-white/15 pl-3 text-pretty italic" {...props} />
  ),
  hr: ({ node, ...props }) => <hr className="my-4 h-px border-0 bg-white/10" {...props} />,
  li: ({ node, ...props }) => <li className="text-pretty" {...props} />,
  code: ({ inline, ...props }) =>
    inline ? (
      <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[0.92em] text-neutral-400" {...props} />
    ) : (
      <code {...props} />
    ),
  pre: ({ node, ...props }) => (
    <pre className="my-3 overflow-x-auto rounded-xl bg-black/25 p-3 text-xs leading-5 text-neutral-400 shadow-[var(--shadow-border)]" {...props} />
  ),
  ul: ({ node, ...props }) => (
    <ul className={`${NESTED_LIST_SPACING} my-3 list-disc space-y-1 pl-5 text-pretty marker:text-neutral-600`} {...props} />
  ),
  ol: ({ node, ...props }) => (
    <ol className={`${NESTED_LIST_SPACING} my-3 list-decimal space-y-1 pl-5 text-pretty marker:text-neutral-600`} {...props} />
  ),
};

export default function ThinkingContent({ children }) {
  return (
    <ReactMarkdown components={THINKING_MARKDOWN_COMPONENTS}>
      {formatThinkingMarkdown(children)}
    </ReactMarkdown>
  );
}
