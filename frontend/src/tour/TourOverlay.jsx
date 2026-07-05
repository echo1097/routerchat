import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cx, CONTROL_MOTION } from "../uiShared.js";

const spotlightPadding = 8;
const popoverWidth = 300;
const popoverGap = 14;

function measureTarget(selector) {
  if (typeof document === "undefined") return null;
  const element = document.querySelector(selector);
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  return rect;
}



function placePopover(rect) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const spaceBelow = viewportHeight - rect.bottom;
  const placeAbove = spaceBelow < 190 && rect.top > 190;

  const rawLeft = rect.left + rect.width / 2 - popoverWidth / 2;
  const left = Math.min(Math.max(rawLeft, 12), viewportWidth - popoverWidth - 12);
  const top = placeAbove ? rect.top - popoverGap : rect.bottom + popoverGap;

  return { left, top, placeAbove };
}

function TourOverlay({ step, stepNumber, stepCount, isLastStep, onNext, onPrevious, onClose }) {
  const [targetRect, setTargetRect] = useState(null);
  const [popoverPosition, setPopoverPosition] = useState(null);
  const [placeAbove, setPlaceAbove] = useState(false);

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
      const placement = placePopover(rect);
      setPopoverPosition({ left: placement.left, top: placement.top });
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
  }, [step]);

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
        className={cx("tour-popover", placeAbove && "tour-popover-above")}
        style={{
          left: `${popoverPosition.left}px`,
          top: `${popoverPosition.top}px`,
          width: `${popoverWidth}px`,
        }}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            Step {stepNumber} of {stepCount}
          </span>
          <button
            type="button"
            aria-label="Close tour"
            onClick={onClose}
            className={cx("text-zinc-500 hover:text-zinc-200", CONTROL_MOTION)}
          >
            <i className="fi fi-br-cross-small" aria-hidden="true" />
          </button>
        </div>

        <p className="mb-4 text-pretty text-sm leading-6 text-zinc-200">{step.body}</p>

        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            disabled={stepNumber === 1}
            onClick={onPrevious}
            className={cx(
              "flex-1 rounded-full border border-line px-3 py-1.5 text-[12px] font-medium text-zinc-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-40",
              CONTROL_MOTION,
            )}
          >
            Previous
          </button>
          <button
            type="button"
            onClick={onNext}
            className={cx(
              "flex-1 rounded-full bg-accent px-3 py-1.5 text-[12px] font-semibold text-zinc-950 hover:bg-blue-300",
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
