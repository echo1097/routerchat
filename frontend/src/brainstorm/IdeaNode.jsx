import { Handle, Position } from "@xyflow/react";
import { Check, Copy, Trash2 } from "lucide-react";
import { cx } from "../uiShared.js";
import { useCopyAction } from "./brainstormShared.jsx";

export default function IdeaNode({ data }) {
  const [copied, copyIdea] = useCopyAction(() => `${data.title}\n-\n${data.content}`);

  function stopClick(action) {
    return (event) => {
      event.stopPropagation();
      action?.();
    };
  }

  return (
    <article
      className={cx(
        "brainstorm-card",
        data.isReading && "is-reading",
        data.isBranch && "is-branch",
      )}
    >
      <Handle type="target" position={Position.Left} className="brainstorm-handle" />

      <div className="brainstorm-card-top">
        <h3 className="brainstorm-card-title">{data.title}</h3>
        {data.isBranch && (
          <span className="brainstorm-card-tag" title="Branching from this idea">
            <Check size={11} strokeWidth={3} aria-hidden="true" />
          </span>
        )}
      </div>
      <p className="brainstorm-card-teaser">{data.content}</p>

      <div className="brainstorm-card-actions brainstorm-node-actions nodrag">
        <button
          type="button"
          onClick={stopClick(copyIdea)}
          aria-label="Copy idea"
          title={copied ? "Copied" : "Copy idea"}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
        <button
          type="button"
          className="is-danger"
          onClick={stopClick(data.onDelete)}
          disabled={data.operationInProgress}
          aria-label="Delete idea"
          title="Delete idea"
        >
          <Trash2 size={15} />
        </button>
      </div>

      <Handle type="source" position={Position.Right} className="brainstorm-handle" />
    </article>
  );
}
