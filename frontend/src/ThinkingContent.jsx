import ReactMarkdown from "react-markdown";

function formatThinkingMarkdown(value) {
  return (value || "")
    .replace(/([^\n])\s+(\d+\.\s+)/g, "$1\n$2")
    .replace(/:\n(\d+\.\s+)/g, ":\n\n$1");
}

// Module scope on purpose: inline components would be new element types on every render, so
// streamed reasoning would tear down and rebuild this whole subtree on each token.
const THINKING_MARKDOWN_COMPONENTS = {
  p: ({ node, ...props }) => <p className="mb-3 text-pretty last:mb-0" {...props} />,
  code: ({ inline, ...props }) =>
    inline ? (
      <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[0.92em] text-zinc-400" {...props} />
    ) : (
      <code {...props} />
    ),
  pre: ({ node, ...props }) => (
    <pre className="my-3 overflow-x-auto rounded-xl bg-black/25 p-3 text-xs leading-5 text-zinc-400 shadow-[var(--shadow-border)]" {...props} />
  ),
  ul: ({ node, ...props }) => (
    <ul className="my-3 list-disc space-y-1 pl-5 text-pretty marker:text-zinc-600" {...props} />
  ),
  ol: ({ node, ...props }) => (
    <ol className="my-3 list-decimal space-y-1 pl-5 text-pretty marker:text-zinc-600" {...props} />
  ),
};

export default function ThinkingContent({ children }) {
  return (
    <ReactMarkdown components={THINKING_MARKDOWN_COMPONENTS}>
      {formatThinkingMarkdown(children)}
    </ReactMarkdown>
  );
}
