import { useRef } from "react";
import { Check, Copy } from "lucide-react";
import { useCopyAction } from "../brainstorm/brainstormShared.jsx";
import { CONTROL_MOTION, cx } from "../uiShared.js";

function codeLanguage(node) {
  const classNames = node?.children?.[0]?.properties?.className || [];
  const languageClass = classNames.find((name) => String(name).startsWith("language-"));

  return languageClass ? String(languageClass).slice("language-".length) : "";
}

export function CodeBlock({ node, ...props }) {
  const preRef = useRef(null);
  const [copied, copyCode] = useCopyAction(() => preRef.current?.textContent || "");

  const language = codeLanguage(node);
  const label = copied ? "Copied" : "Copy code";

  return (
    <div className="chat-code my-4 overflow-hidden rounded-2xl bg-white/[0.045]">
      <div className="flex items-center justify-between py-1.5 pl-4 pr-2 text-xs text-neutral-500">
        <span>{language}</span>
        <button
          type="button"
          aria-label={label}
          title={label}
          onClick={copyCode}
          className={cx(
            "inline-flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:text-neutral-100 focus:outline-none",
            CONTROL_MOTION,
          )}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      <pre ref={preRef} className="overflow-x-auto px-4 pb-4 text-sm leading-6" {...props} />
    </div>
  );
}
