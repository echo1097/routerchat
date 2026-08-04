import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import ThinkingContent from "../ThinkingContent.jsx";
import { useRafScroller } from "../streamScroll.js";
import { useTextSwap } from "../textSwap.js";
import { cx, CONTROL_MOTION } from "../uiShared.js";

//split so the count can be bolded on its own, the unit word stays in the body weight
export function repairDurationParts(durationMs) {
  const seconds = Math.max(1, Math.round(Number(durationMs || 0) / 1000));
  return { seconds, unit: seconds === 1 ? "second" : "seconds" };
}

//the confirm/thinking/done/failed dance is identical for every repair, only the words change
export default function RepairModal({
  open,
  stage,
  phase,
  reasoning,
  error,
  idPrefix,
  titles,
  closeLabel,
  confirmLabel,
  description,
  runningLabel,
  completeMessage,
  errorLead,
  reasoningTestId,
  onConfirm,
  onClose,
}) {
  const [rendered, setRendered] = useState(open);
  const [modalState, setModalState] = useState(open ? "open" : "closed");
  const [bodyHeight, setBodyHeight] = useState(null);
  const reasoningRef = useRef(null);
  const bodyInnerRef = useRef(null);
  const {
    markUserScroll: markReasoningScroll,
    markWheelIntent: markReasoningWheelIntent,
    markTouchStart: markReasoningTouchStart,
    markTouchMove: markReasoningTouchMove,
    scrollToBottom: scrollReasoningToBottom,
    startFollowing: startFollowingReasoning,
  } = useRafScroller(reasoningRef, 32);

  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;

  useEffect(() => {
    if (open) {
      setRendered(true);
      requestAnimationFrame(() => setModalState("open"));
      return undefined;
    }
    if (!rendered) return undefined;

    setModalState("closing");
    const closeMs = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--modal-close-dur"),
    ) || 150;
    const timeoutId = window.setTimeout(() => {
      setRendered(false);
      setModalState("closed");
      setBodyHeight(null); //next open should measure fresh instead of tweening from the old stage
    }, closeMs);
    return () => window.clearTimeout(timeoutId);
  }, [open, rendered]);

  //the body owns the size change between stages, so pin it to whatever the current stage measures
  useLayoutEffect(() => {
    const inner = bodyInnerRef.current;
    if (!inner) return undefined;

    function syncBodyHeight() {
      setBodyHeight(inner.offsetHeight); //offsetHeight, not a rect, the modal is mid scale transform while it opens
    }

    syncBodyHeight();

    const observer = new ResizeObserver(syncBodyHeight);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [rendered]);

  //start pinned to the newest thinking, then follow along unless the reader scrolls up to re-read
  useEffect(() => {
    if (stage !== "running") return;
    startFollowingReasoning();
  }, [stage, startFollowingReasoning]);

  useEffect(() => {
    if (stage !== "running") return;
    scrollReasoningToBottom();
  }, [reasoning, scrollReasoningToBottom, stage]);

  useEffect(() => {
    if (!open || stage === "running") return undefined;

    function handleKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open, stage]);

  const isRunning = stage === "running";
  const title = stage === "confirm"
    ? titles.confirm
    : stage === "complete"
      ? titles.complete
      : stage === "error"
        ? titles.error
        : phase === "writing"
          ? "Writing"
          : "Thinking";
  const { shownText: shownTitle, textRef: titleRef } = useTextSwap(title);
  //the finished stage already has a Done button so the corner x is just a second way to do the same thing
  const showCloseIcon = stage === "confirm" || stage === "error";

  if (!rendered) return null;

  return createPortal(
    <div className="lorebook-modal-guard fixed inset-0 z-[80] grid place-items-center bg-black/60 px-3 py-4 backdrop-blur-sm sm:px-6">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label={closeLabel}
        onClick={onClose}
        disabled={isRunning}
      />
      <section
        className={cx(
          "lorebook-modal",
          "lorebook-repair-modal",
          "t-modal",
          modalState === "open" && "is-open",
          modalState === "closing" && "is-closing",
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header>
          <h2 id={titleId} className="lorebook-repair-title">
            <span
              ref={titleRef}
              className={cx("lorebook-repair-title-text", "t-text-swap", isRunning && "t-shimmer")}
              data-text={shownTitle}
            >
              {shownTitle}
            </span>
          </h2>
          {showCloseIcon && (
            <button
              type="button"
              className={cx("lorebook-icon-button", CONTROL_MOTION)}
              onClick={onClose}
              aria-label={closeLabel}
            >
              <X size={18} />
            </button>
          )}
        </header>

        <div
          className={cx("lorebook-modal-body", "lorebook-repair-modal-body", "t-resize")}
          style={bodyHeight === null ? undefined : { height: `${bodyHeight}px` }}
        >
          <div ref={bodyInnerRef} className="lorebook-repair-modal-body-inner">
            {stage === "confirm" && (
              <p id={descriptionId} className="lorebook-repair-description">
                {description}
              </p>
            )}

            {stage === "running" && (
              <>
                {/* the shimmering header carries the state visually, this is just for screen readers */}
                <span className="sr-only" role="status" aria-live="polite">
                  {phase === "writing" ? runningLabel.writing : runningLabel.thinking}
                </span>
                <div
                  id={descriptionId}
                  ref={reasoningRef}
                  onScroll={markReasoningScroll}
                  onWheel={markReasoningWheelIntent}
                  onTouchStart={markReasoningTouchStart}
                  onTouchMove={markReasoningTouchMove}
                  className={cx("lorebook-repair-reasoning", !reasoning && "is-empty")}
                  data-testid={reasoningTestId}
                >
                  {reasoning ? (
                    <ThinkingContent>{reasoning}</ThinkingContent>
                  ) : (
                    <span>Waiting for the model to share its thinking.</span>
                  )}
                </div>
              </>
            )}

            {stage === "complete" && (
              <p
                id={descriptionId}
                className="lorebook-repair-result"
                role="status"
                aria-live="polite"
              >
                {completeMessage}
              </p>
            )}

            {stage === "error" && (
              <div id={descriptionId} className="lorebook-repair-error" role="alert">
                <p>{errorLead}</p>
                <span>{error}</span>
              </div>
            )}

            {/* the footer rides inside the measured wrapper so losing the buttons mid repair tweens
            with everything else instead of snapping the dialog shorter */}
            {!isRunning && (
              <footer>
                <div className="lorebook-footer-actions">
                  {stage === "confirm" ? (
                    <>
                      <button
                        type="button"
                        className={cx("lorebook-secondary-button", CONTROL_MOTION)}
                        onClick={onClose}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className={cx("lorebook-primary-button", CONTROL_MOTION)}
                        onClick={onConfirm}
                        autoFocus
                      >
                        {confirmLabel}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={cx("lorebook-primary-button", CONTROL_MOTION)}
                      onClick={onClose}
                      autoFocus
                    >
                      {stage === "complete" ? "Done" : "Close"}
                    </button>
                  )}
                </div>
              </footer>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
