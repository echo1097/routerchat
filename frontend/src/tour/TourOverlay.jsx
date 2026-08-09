import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx, CONTROL_MOTION } from "../uiShared.js";

const spotlightPadding = 8;
const popoverWidth = 300;
//only the opening guess, the real height gets measured once the card is on screen because a long step body blows straight past this
const estimatedPopoverHeight = 210;
const popoverGap = 14;
const viewportMargin = 12;

function measureTarget(selector) {
  if (typeof document === "undefined") return null;
  const element = document.querySelector(selector);
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  return rect;
}



function placePopover(rect, popoverHeight) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  //never taller than the screen it has to sit on, the card scrolls its own body if it comes to that
  const height = Math.min(popoverHeight, viewportHeight - viewportMargin * 2);

  const roomBelow = viewportHeight - rect.bottom;
  const roomAbove = rect.top;
  const placeAbove = roomBelow < height + popoverGap && roomAbove >= height + popoverGap;

  const rawLeft = rect.left + rect.width / 2 - popoverWidth / 2;
  const left = Math.min(
    Math.max(rawLeft, viewportMargin),
    viewportWidth - popoverWidth - viewportMargin,
  );
  const rawTop = placeAbove ? rect.top - height - popoverGap : rect.bottom + popoverGap;
  const top = Math.min(
    Math.max(rawTop, viewportMargin),
    Math.max(viewportMargin, viewportHeight - height - viewportMargin),
  );

  return { left, top, placeAbove, maxHeight: viewportHeight - viewportMargin * 2 };
}

function TourOverlay({ step, stepNumber, stepCount, isLastStep, onNext, onPrevious, onClose }) {
  const [targetRect, setTargetRect] = useState(null);
  const [popoverPosition, setPopoverPosition] = useState(null);
  const [placeAbove, setPlaceAbove] = useState(false);
  const [popoverHeight, setPopoverHeight] = useState(estimatedPopoverHeight);
  const popoverRef = useRef(null);

  //a new step means new body text, so drop back to the guess and let it get measured again
  useLayoutEffect(() => {
    setPopoverHeight(estimatedPopoverHeight);
  }, [step]);

  useLayoutEffect(() => {
    if (!step) return undefined;

    let frameId = null;

    function measure() {
      const rect = measureTarget(step.selector);

      if (!rect) {
        frameId = requestAnimationFrame(measure);
        return;
      }

      setTargetRect(rect);
      const placement = placePopover(rect, popoverHeight);
      setPopoverPosition({ left: placement.left, top: placement.top, maxHeight: placement.maxHeight });
      setPlaceAbove(placement.placeAbove);
    }

    measure();

    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step, popoverHeight]);

  //measure what the card actually came out to, then reposition against that instead of the guess
  useLayoutEffect(() => {
    const node = popoverRef.current;
    if (!node) return;

    const height = node.getBoundingClientRect().height;
    if (height > 0 && Math.abs(height - popoverHeight) > 1) setPopoverHeight(height);
  });

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!step || !targetRect || !popoverPosition || typeof document === "undefined") return null;

  return createPortal(
    <div className="tour-layer" role="dialog" aria-modal="true" aria-label="Help tour">
      {/* this is the click blocker, it covers the whole screen so people cant */}
      {/* poke at the real buttons mid tour, it just cant stop them from trying */}
      <div className="tour-backdrop" />

      <div
        className="tour-spotlight"
        style={{
          left: `${targetRect.left - spotlightPadding}px`,
          top: `${targetRect.top - spotlightPadding}px`,
          width: `${targetRect.width + spotlightPadding * 2}px`,
          height: `${targetRect.height + spotlightPadding * 2}px`,
        }}
      />

      <div
        ref={popoverRef}
        className={cx("tour-popover", placeAbove && "tour-popover-above")}
        style={{
          left: `${popoverPosition.left}px`,
          top: `${popoverPosition.top}px`,
          width: `${popoverWidth}px`,
          maxHeight: `${popoverPosition.maxHeight}px`,
        }}
      >
        <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Step {stepNumber} of {stepCount}
          </span>
          <button
            type="button"
            aria-label="Close tour"
            onClick={onClose}
            className={cx("text-neutral-500 hover:text-neutral-200", CONTROL_MOTION)}
          >
            <i className="fi fi-br-cross-small" aria-hidden="true" />
          </button>
        </div>

        {/* the body is the only part allowed to scroll, the step counter and the buttons stay put */}
        <p className="mb-4 min-h-0 overflow-y-auto text-pretty text-sm leading-6 text-neutral-200">
          {step.body}
        </p>

        <div className="flex shrink-0 items-center justify-center gap-2">
          <button
            type="button"
            disabled={stepNumber === 1}
            onClick={onPrevious}
            className={cx(
              "flex-1 rounded-full border border-line px-3 py-1.5 text-[12px] font-medium text-neutral-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-40",
              CONTROL_MOTION,
            )}
          >
            Previous
          </button>
          <button
            type="button"
            onClick={onNext}
            className={cx(
              "flex-1 rounded-full bg-accent px-3 py-1.5 text-[12px] font-semibold text-neutral-950 hover:bg-white",
              CONTROL_MOTION,
            )}
          >
            {isLastStep ? "Finish tour" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default TourOverlay;
