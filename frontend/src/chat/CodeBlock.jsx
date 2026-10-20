import { useRef } from "react";
import { Check, Copy } from "lucide-react";
import { useCopyAction } from "../brainstorm/brainstormShared.jsx";
import { CONTROL_MOTION, cx } from "../uiShared.js";

export function CodeBlock({ node, ...props }) {
  const preRef = useRef(null);
  const [copied, copyCode] = useCopyAction(() => preRef.current?.textContent || "");

  const label = copied ? "Copied" : "Copy code";

  return (
    <div className="relative my-4">
      <pre
        ref={preRef}
        className="overflow-x-auto rounded-2xl bg-white/[0.045] p-4 pr-12 text-sm leading-6"
        {...props}
      />
      <div className="absolute right-0 top-0 rounded-bl-xl rounded-tr-2xl bg-[#131313] p-2">
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
    </div>
  );
}
