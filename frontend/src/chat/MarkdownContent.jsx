import remarkGfm from "remark-gfm";
import { remarkCitationPills, isCitationLink } from "../websearch/citations.js";
import { memo } from "react";
import { streamWordsPlugin } from "../streamingText.js";
import ReactMarkdown from "react-markdown";
import { MARKDOWN_IMAGE_COMPONENT } from "../markdownImage.jsx";
import { InlineCitation } from "../websearch/SourcePills.jsx";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkCitationPills];

function markdownLinkText(children) {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(markdownLinkText).join("");
  if (children?.props?.children) return markdownLinkText(children.props.children);

  return "";
}

export const MarkdownContent = memo(function MarkdownContent({ children, streaming, settledRef }) {

  const rehypePlugins = streaming ? [streamWordsPlugin(settledRef)] : undefined;

  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={rehypePlugins}
      components={{
        ...MARKDOWN_IMAGE_COMPONENT,
        h1: ({ node, ...props }) => (
          <h1 className="mb-4 mt-6 text-balance text-2xl font-semibold leading-tight tracking-[-0.01em] text-neutral-100 first:mt-0" {...props} />
        ),
        h2: ({ node, ...props }) => (
          <h2 className="mb-3 mt-6 text-balance text-xl font-semibold leading-tight tracking-[-0.01em] text-neutral-100 first:mt-0" {...props} />
        ),
        h3: ({ node, ...props }) => (
          <h3 className="mb-2 mt-5 text-balance text-lg font-semibold leading-snug text-neutral-100 first:mt-0" {...props} />
        ),
        h4: ({ node, ...props }) => (
          <h4 className="mb-2 mt-4 text-balance text-base font-semibold leading-snug text-neutral-100 first:mt-0" {...props} />
        ),
        strong: ({ node, ...props }) => (
          <strong className="font-semibold text-neutral-100" {...props} />
        ),
        p: ({ node, ...props }) => <p className="mb-4 text-pretty last:mb-0" {...props} />,
        a: ({ node, ...props }) => {
          const label = markdownLinkText(props.children);
          if (isCitationLink(props.href, label)) {
            return <InlineCitation href={props.href} label={label} />;
          }

          return (
            <a
              className="text-accent underline decoration-accent/30 underline-offset-4 transition-[color,text-decoration-color] duration-150 ease-out hover:decoration-accent/70"
              target="_blank"
              rel="noreferrer"
              {...props}
            />
          );
        },
        code: ({ inline, ...props }) =>
          inline ? (
            <code className="rounded-md bg-white/[0.07] px-1.5 py-0.5 text-[0.92em] text-neutral-100" {...props} />
          ) : (
            <code {...props} />
          ),
        pre: ({ node, ...props }) => (
          <pre className="my-4 overflow-x-auto rounded-2xl bg-black/35 p-4 text-sm leading-6 shadow-[var(--shadow-border)]" {...props} />
        ),
        ul: ({ node, ...props }) => (
          <ul className="my-4 list-disc space-y-1 pl-5 text-pretty" {...props} />
        ),
        ol: ({ node, ...props }) => (
          <ol className="my-4 list-decimal space-y-1 pl-5 text-pretty" {...props} />
        ),
      }}
    >
      {children || ""}
    </ReactMarkdown>
  );
});
