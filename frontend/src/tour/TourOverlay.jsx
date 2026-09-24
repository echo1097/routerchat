import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { cx, CONTROL_MOTION } from "../uiShared.js";

const spotlightPadding = 8;
const popoverWidth = 312;
//only the opening guess, the real height gets measured once the card is on screen because a long step body blows straight past this
const estimatedPopoverHeight = 210;
const popoverGap = 16;
const viewportMargin = 12;
const arrowInset = 22;

function measureTarget(selector) {
  if (typeof document === "undefined") return null;
  const element = document.querySelector(selector);
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  let spotLeft = rect.left - spotlightPadding;
  let spotTop = rect.top - spotlightPadding;
  let spotRight = rect.right + spotlightPadding;
  let spotBottom = rect.bottom + spotlightPadding;

  const container = element.closest('[role="menu"]');
  const containerRect = container?.getBoundingClientRect();

  if (containerRect) {
    spotLeft = Math.max(spotLeft, containerRect.left);
    spotTop = Math.max(spotTop, containerRect.top);
    spotRight = Math.min(spotRight, containerRect.right);
    spotBottom = Math.min(spotBottom, containerRect.bottom);
  }

  const paddingUsed = Math.min(
    rect.left - spotLeft,
    rect.top - spotTop,
    spotRight - rect.right,
    spotBottom - rect.bottom,
  );

  const cornerRadius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
  let radius = Math.min(cornerRadius + paddingUsed, (spotBottom - spotTop) / 2);

  if (container) {
    const containerRadius = parseFloat(getComputedStyle(container).borderTopLeftRadius) || 0;
    radius = Math.min(radius, containerRadius);
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    bottom: rect.bottom,
    spotLeft,
    spotTop,
    spotWidth: spotRight - spotLeft,
    spotHeight: spotBottom - spotTop,
    radius,
  };
}


function sameTarget(first, second) {
  if (!first || !second) return false;

  return (
    Math.abs(first.left - second.left) < 0.5 &&
    Math.abs(first.top - second.top) < 0.5 &&
    Math.abs(first.width - second.width) < 0.5 &&
    Math.abs(first.height - second.height) < 0.5 &&
    Math.abs(first.spotLeft - second.spotLeft) < 0.5 &&
    Math.abs(first.spotTop - second.spotTop) < 0.5 &&
    Math.abs(first.spotWidth - second.spotWidth) < 0.5 &&
    Math.abs(first.spotHeight - second.spotHeight) < 0.5 &&
    first.radius === second.radius
  );
}


function placePopover(rect, popoverHeight) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(popoverWidth, viewportWidth - viewportMargin * 2);

  //never taller than the screen it has to sit on, the card scrolls its own body if it comes to that
  const height = Math.min(popoverHeight, viewportHeight - viewportMargin * 2);

  const roomBelow = viewportHeight - rect.bottom;
  const roomAbove = rect.top;
  const placeAbove = roomBelow < height + popoverGap && roomAbove >= height + popoverGap;

  const targetCenter = rect.left + rect.width / 2;
  const rawLeft = targetCenter - width / 2;
  const left = Math.min(
    Math.max(rawLeft, viewportMargin),
    viewportWidth - width - viewportMargin,
  );
  const rawTop = placeAbove ? rect.top - height - popoverGap : rect.bottom + popoverGap;
  const top = Math.min(
    Math.max(rawTop, viewportMargin),
    Math.max(viewportMargin, viewportHeight - height - viewportMargin),
  );

  const arrowLeft = Math.min(Math.max(targetCenter - left, arrowInset), width - arrowInset);
  const showArrow = placeAbove ? top + height <= rect.top : top >= rect.bottom;

  return {
    left,
    top,
    width,
    placeAbove,
    arrowLeft,
    showArrow,
    maxHeight: viewportHeight - viewportMargin * 2,
  };
}


function TourProgress({ stepNumber, stepCount }) {
  return (
    <div className="tour-progress" aria-hidden="true">
      {Array.from({ length: stepCount }, (_, index) => (
        <span
          key={index}
          className={cx(
            "tour-progress-segment",
            index < stepNumber - 1 && "is-done",
            index === stepNumber - 1 && "is-current",
          )}
        />
      ))}
    </div>
  );
}


function TourOverlay({ step, stepNumber, stepCount, isLastStep, onNext, onPrevious, onClose }) {
  const [targetRect, setTargetRect] = useState(null);
  const [placement, setPlacement] = useState(null);
  const [popoverHeight, setPopoverHeight] = useState(estimatedPopoverHeight);
  const popoverRef = useRef(null);
  const nextButtonRef = useRef(null);

  //a new step means new body text, so drop back to the guess and let it get measured again
  useLayoutEffect(() => {
    setPopoverHeight(estimatedPopoverHeight);
  }, [step]);

  useLayoutEffect(() => {
    if (!step) return undefined;

    let frameId = null;
    let lastRect = null;
    let lastViewport = "";

    function measure() {
      const rect = measureTarget(step.selector);
      const viewport = `${window.innerWidth}x${window.innerHeight}`;

      if (rect && (!sameTarget(rect, lastRect) || viewport !== lastViewport)) {
        lastRect = rect;
        lastViewport = viewport;
        setTargetRect(rect);
        setPlacement(placePopover(rect, popoverHeight));
      }

      frameId = requestAnimationFrame(measure);
    }

    measure();

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
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

  const isReady = Boolean(step && targetRect && placement);

  useEffect(() => {
    if (isReady) nextButtonRef.current?.focus({ preventScroll: true });
  }, [isReady, step]);

  if (!isReady || typeof document === "undefined") return null;

  return createPortal(
    <div className="tour-layer" role="dialog" aria-modal="true" aria-label="Help tour">
      {/* this is the click blocker, it covers the whole screen so people cant */}
      {/* poke at the real buttons mid tour, it just cant stop them from trying */}
      <div className="tour-backdrop" />

      <div
        className="tour-spotlight"
        style={{
          left: `${targetRect.spotLeft}px`,
          top: `${targetRect.spotTop}px`,
          width: `${targetRect.spotWidth}px`,
          height: `${targetRect.spotHeight}px`,
          borderRadius: `${targetRect.radius}px`,
        }}
      >
        <span key={step.id} className="tour-spotlight-ping" />
      </div>

      <div
        ref={popoverRef}
        className={cx("tour-popover", placement.placeAbove && "tour-popover-above")}
        style={{
          left: `${placement.left}px`,
          top: `${placement.top}px`,
          width: `${placement.width}px`,
          maxHeight: `${placement.maxHeight}px`,
          "--tour-arrow-left": `${placement.arrowLeft}px`,
        }}
      >
        {placement.showArrow && <span className="tour-popover-arrow" aria-hidden="true" />}

        <div className="flex shrink-0 items-center gap-3">
          <span className="shrink-0 text-[12px] font-medium tabular-nums text-neutral-400">
            <span className="text-neutral-100">{stepNumber}</span>
            <span className="px-[3px] text-neutral-600">/</span>
            {stepCount}
          </span>

          <TourProgress stepNumber={stepNumber} stepCount={stepCount} />

          <button
            type="button"
            aria-label="Close tour"
            onClick={onClose}
            className={cx(
              "-mr-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-white/[0.07] hover:text-neutral-100 focus:outline-none focus-visible:bg-white/[0.07] focus-visible:text-neutral-100",
              CONTROL_MOTION,
            )}
          >
            <X size={15} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </div>

        {/* the body is the only part allowed to scroll, the step counter and the buttons stay put */}
        <p
          key={step.id}
          aria-live="polite"
          className="tour-body mb-4 mt-3 min-h-0 overflow-y-auto text-pretty text-[14px] leading-[1.6] text-neutral-100"
        >
          {step.body}
        </p>

        <div className="flex shrink-0 items-center justify-center gap-2">
          <button
            type="button"
            disabled={stepNumber === 1}
            onClick={onPrevious}
            className={cx(
              "inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-white/[0.05] px-3 text-[13px] font-medium text-neutral-300 hover:bg-white/[0.09] hover:text-white focus:outline-none focus-visible:bg-white/[0.09] focus-visible:text-white disabled:pointer-events-none disabled:opacity-35",
              CONTROL_MOTION,
            )}
          >
            <ArrowLeft size={14} strokeWidth={2.25} aria-hidden="true" />
            Previous
          </button>
          <button
            ref={nextButtonRef}
            type="button"
            onClick={onNext}
            className={cx(
              "tour-next inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-neutral-100 px-3 text-[13px] font-semibold text-neutral-950 hover:bg-neutral-300 focus:outline-none focus-visible:bg-neutral-300",
              CONTROL_MOTION,
            )}
          >
            {isLastStep ? "Finish tour" : "Next"}
            {isLastStep ? (
              <Check size={14} strokeWidth={2.5} aria-hidden="true" className="tour-next-icon" />
            ) : (
              <ArrowRight size={14} strokeWidth={2.25} aria-hidden="true" className="tour-next-icon" />
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default TourOverlay;
