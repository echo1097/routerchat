import { useState, useRef, useId, useCallback, useEffect, useLayoutEffect } from "react";
import { useRafScroller } from "../streamScroll.js";
import { formatThoughtDuration } from "../textFormatting.js";
import { createPortal } from "react-dom";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import ThinkingContent from "../ThinkingContent.jsx";
import { ThinkingStatus } from "../thinkingStates.jsx";
import { ChevronDown } from "lucide-react";

function editPreviewPhrase(operation, anchor) {
  const snippet = anchor ? `“${anchor.length > 60 ? `${anchor.slice(0, 60)}…` : anchor}”` : "";
  switch (operation) {
    case "replaceBlock":
      return snippet ? `Rewriting near ${snippet}` : "Rewriting a paragraph";
    case "insertBeforeBlock":
      return snippet ? `Inserting before ${snippet}` : "Inserting a paragraph";
    case "insertAfterBlock":
      return snippet ? `Inserting after ${snippet}` : "Inserting a paragraph";
    case "replaceBlockRange":
      return "Replacing a range";
    case "appendToChapter":
      return "Appending to the chapter";
    default:
      return "Writing an edit";
  }
}

const WRITE_STATUS_STATES = [
  "Preparing",
  "Working",
  "Thinking",
  "Writing",
  "Fixing the edit",
  "Updating Lorebook",
  "Reconciling",
];

export const LOREBOOK_PHASE_LABELS = {
  working: "Working",
  thinking: "Thinking",
  updating: "Updating Lorebook",
};

export function WriteOperationStatus({
  status,
  reasoning = "",
  reasoningStreaming = false,
  reasoningDurationMs = null,
  editPreview = null,
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const dismissedRef = useRef(false); 
  const toggleRef = useRef(null);
  const popoverRef = useRef(null);
  const reasoningScrollRef = useRef(null);
  const editScrollRef = useRef(null);
  const [popoverPosition, setPopoverPosition] = useState(null);
  const popoverId = useId();
  const {
    markUserScroll: markReasoningScroll,
    markWheelIntent: markReasoningWheelIntent,
    markTouchStart: markReasoningTouchStart,
    markTouchMove: markReasoningTouchMove,
    scrollToBottom: scrollReasoningToBottom,
    startFollowing: startReasoningFollowing,
  } = useRafScroller(reasoningScrollRef, 32);
  const {
    markUserScroll: markEditScroll,
    markWheelIntent: markEditWheelIntent,
    markTouchStart: markEditTouchStart,
    markTouchMove: markEditTouchMove,
    scrollToBottom: scrollEditToBottom,
    startFollowing: startEditFollowing,
  } = useRafScroller(editScrollRef, 32);

  const hasReasoning = Boolean(reasoning);
  const reasoningLabel =
    !reasoningStreaming && reasoningDurationMs
      ? `Thought for ${formatThoughtDuration(reasoningDurationMs)}`
      : "Thinking";

  const hasEditPreview = Boolean(editPreview && (editPreview.newText || editPreview.operation));
  const editLabel = editPreview ? `Edit ${editPreview.editIndex + 1}` : "";
  const editPhrase = editPreview ? editPreviewPhrase(editPreview.operation, editPreview.anchor) : "";
  const editStreaming = Boolean(editPreview && !editPreview.newTextComplete);

  const hasDetails = hasReasoning || hasEditPreview;

  const positionPopover = useCallback(() => {
    const toggle = toggleRef.current;
    if (!detailsOpen || !toggle) return;

    const margin = 16;
    const gap = 8;
    const maxWidth = 480;
    const rect = toggle.getBoundingClientRect();
    const width = Math.min(maxWidth, window.innerWidth - margin * 2);
    const left = Math.min(
      Math.max(rect.right - width, margin),
      window.innerWidth - width - margin,
    );
    const top = Math.max(rect.bottom + gap, margin);

    setPopoverPosition({
      top,
      left,
      width,
      maxHeight: Math.max(160, window.innerHeight - top - margin),
    });
  }, [detailsOpen]);

  useEffect(() => {
    if (!hasEditPreview || dismissedRef.current) return;
    setDetailsOpen(true);
  }, [hasEditPreview]);

  useEffect(() => {
    if (!detailsOpen) return;
    startReasoningFollowing();
    startEditFollowing();
  }, [detailsOpen, startReasoningFollowing, startEditFollowing]);

  useLayoutEffect(() => {
    if (!detailsOpen) {
      setPopoverPosition(null);
      return undefined;
    }

    positionPopover();
    function repositionForScroll(event) {
      if (popoverRef.current?.contains(event.target)) return;
      positionPopover();
    }
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", repositionForScroll, true);

    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", repositionForScroll, true);
    };
  }, [detailsOpen, positionPopover]);

  useEffect(() => {
    if (!detailsOpen) return;
    scrollReasoningToBottom();
  }, [reasoning, detailsOpen, scrollReasoningToBottom]);

  useEffect(() => {
    if (!detailsOpen) return;
    scrollEditToBottom();
  }, [editPreview, detailsOpen, scrollEditToBottom]);

  const detailsPopover = hasDetails && detailsOpen && popoverPosition
    ? createPortal(
      <span
        id={popoverId}
        ref={popoverRef}
        role="region"
        aria-label="Writing details"
        className="t-dropdown write-thinking-popover is-open"
        data-origin="top-right"
        style={popoverPosition}
      >
        {hasReasoning && (
          <>
            <span className="write-thinking-popover-header">
              <span className="write-thinking-popover-heading">
                <span
                  className={cx("write-thinking-popover-title", reasoningStreaming && "t-shimmer")}
                  data-text={reasoningLabel}
                >
                  {reasoningLabel}
                </span>
              </span>
            </span>
            <span
              ref={reasoningScrollRef}
              onScroll={markReasoningScroll}
              onWheel={markReasoningWheelIntent}
              onTouchStart={markReasoningTouchStart}
              onTouchMove={markReasoningTouchMove}
              className="write-thinking-popover-content"
              data-testid="write-thinking-scroll"
            >
              <ThinkingContent>{reasoning}</ThinkingContent>
            </span>
          </>
        )}
        {hasReasoning && hasEditPreview && <span className="write-thinking-popover-divider" />}
        {hasEditPreview && (
          <>
            <span className="write-thinking-popover-header">
              <span className="write-thinking-popover-heading">
                <span
                  className={cx("write-thinking-popover-title", editStreaming && "t-shimmer")}
                  data-text={editLabel}
                >
                  {editLabel}
                </span>
                <span className="write-thinking-popover-subtitle">{editPhrase}</span>
              </span>
            </span>
            <span
              ref={editScrollRef}
              onScroll={markEditScroll}
              onWheel={markEditWheelIntent}
              onTouchStart={markEditTouchStart}
              onTouchMove={markEditTouchMove}
              className="write-thinking-popover-content"
              data-testid="write-edit-preview-scroll"
            >
              <ThinkingContent>{editPreview.newText}</ThinkingContent>
            </span>
          </>
        )}
      </span>,
      document.body,
    )
    : null;

  return (
    <>
      <span className="write-operation-wrap">
        <span className="write-operation-status" aria-live="polite">
          <button
            ref={toggleRef}
            type="button"
            onClick={hasDetails ? () => setDetailsOpen((value) => {
              if (value) dismissedRef.current = true;
              return !value;
            }) : undefined}
            disabled={!hasDetails}
            className={cx(
              "write-operation-thinking-toggle",
              !hasDetails && "is-static",
              CONTROL_MOTION,
            )}
            aria-label={detailsOpen ? "Collapse writing details" : "Expand writing details"}
            aria-expanded={hasDetails ? detailsOpen : undefined}
            aria-controls={hasDetails ? popoverId : undefined}
          >
            <ThinkingStatus
              label={status}
              states={WRITE_STATUS_STATES}
              align="right"
              className="write-operation-label"
            />
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={cx(
                "write-operation-thinking-chevron transition-[transform,opacity] duration-[var(--dropdown-open-dur)] ease-[var(--dropdown-ease)]",
                !detailsOpen && "-rotate-90",
                !hasDetails && "opacity-0",
              )}
            />
          </button>
        </span>
      </span>
      {detailsPopover}
    </>
  );
}
