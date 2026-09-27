import { useEffect, useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { Check, ChevronDown, Copy, RefreshCw, Trash2 } from "lucide-react";
import ThinkingContent from "../ThinkingContent.jsx";
import { cx } from "../uiShared.js";
import { NodeText, brainstormDurationLabel, useCopyAction } from "./brainstormShared.jsx";

export default function PromptNode({ data }) {
  const failed = data.status === "failed" || data.status === "cancelled";
  const actionsLocked = Boolean(data.operationInProgress);
  const isGenerating = data.status === "generating";
  const isThinking = isGenerating && data.generation_phase === "thinking";
  const isWorking = isGenerating && data.generation_phase === "working";
  const isWaiting = isGenerating && !isThinking && !isWorking;
  const hasThinking = Boolean(data.reasoning) || isThinking;
  const showPlainStatus = (isWaiting || isWorking) && !hasThinking;
  const plainStatusLabel = isWaiting ? "Working" : "Writing";

  let operationLabel = "Thinking";
  if (isWorking) operationLabel = "Writing";
  if (data.status === "complete") {
    operationLabel = `Finished in ${brainstormDurationLabel(data)}`;
  }

  const [thinkingOpen, setThinkingOpen] = useState(isThinking);
  let thinkingAriaLabel = thinkingOpen ? "Collapse thinking" : "Expand thinking";
  if (isWorking) thinkingAriaLabel = "Writing in progress";
  if (isThinking) thinkingAriaLabel = "Thinking in progress";

  const thinkingScrollRef = useRef(null);
  const followThinkingRef = useRef(true);
  const [copied, copyPrompt] = useCopyAction(() => data.content);

  useEffect(() => {
    if (isThinking) {
      followThinkingRef.current = true;
      setThinkingOpen(true);
      return;
    }

    if (isWorking) {
      setThinkingOpen(false);
      return;
    }

    if (!isGenerating) setThinkingOpen(false);
  }, [isGenerating, isThinking, isWorking]);

  useEffect(() => {
    const scrollNode = thinkingScrollRef.current;
    if (!thinkingOpen || !scrollNode || !followThinkingRef.current) return;
    scrollNode.scrollTop = scrollNode.scrollHeight;
  }, [data.reasoning, thinkingOpen]);

  function stopClick(action) {
    return (event) => {
      event.stopPropagation();
      action?.();
    };
  }

  return (
    <article className={cx("brainstorm-prompt-node", failed && "is-failed")}>
      {data.hasIncomingEdge && (
        <Handle type="target" position={Position.Left} className="brainstorm-handle" />
      )}

      <NodeText className="brainstorm-prompt-content nowheel">{data.content}</NodeText>

      <div className="brainstorm-prompt-foot">
        {failed && (
          <span className="brainstorm-prompt-failed">
            {data.status === "failed" ? "Failed" : "Cancelled"}
          </span>
        )}
        {showPlainStatus && (
          <span className="brainstorm-writing-status">
            <span className="brainstorm-thinking-label t-shimmer" data-text={plainStatusLabel}>
              {plainStatusLabel}
            </span>
          </span>
        )}
        {hasThinking && (
          <button
            type="button"
            className={cx("brainstorm-thinking-trigger nodrag nopan", thinkingOpen && "is-open")}
            onClick={stopClick(() => {
              if (isGenerating) return;
              followThinkingRef.current = true;
              setThinkingOpen((open) => !open);
            })}
            disabled={isGenerating}
            aria-expanded={thinkingOpen}
            aria-label={thinkingAriaLabel}
          >
            <span
              className={cx("brainstorm-thinking-label", isGenerating && "t-shimmer")}
              data-text={isGenerating ? operationLabel : undefined}
            >
              {operationLabel}
            </span>
            {!isGenerating && <ChevronDown size={13} aria-hidden="true" />}
          </button>
        )}

        <div className="brainstorm-node-actions nodrag">
          <button
            type="button"
            onClick={stopClick(copyPrompt)}
            aria-label="Copy prompt"
            title={copied ? "Copied" : "Copy prompt"}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <button
            type="button"
            onClick={stopClick(data.onRetry)}
            disabled={actionsLocked || data.generateDisabled}
            aria-label="Regenerate prompt"
            title={data.generateDisabled ? "Add an API key to regenerate" : "Regenerate prompt"}
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            className="is-danger"
            onClick={stopClick(data.onDelete)}
            disabled={actionsLocked}
            aria-label="Delete prompt"
            title="Delete prompt"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {hasThinking && (
        <div className={cx("brainstorm-thinking nodrag nopan", thinkingOpen && "is-open")}>
          <div
            className="brainstorm-thinking-panel"
            aria-hidden={!thinkingOpen}
            inert={thinkingOpen ? undefined : ""}
          >
            <div
              ref={thinkingScrollRef}
              className="brainstorm-thinking-content nodrag nopan nowheel"
              onScroll={(event) => {
                const node = event.currentTarget;
                const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
                followThinkingRef.current = distanceFromBottom < 24;
              }}
            >
              <ThinkingContent>{data.reasoning}</ThinkingContent>
            </div>
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Right} className="brainstorm-handle" />
    </article>
  );
}
