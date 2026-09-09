import { useRef, useEffect, useLayoutEffect } from "react";
import { cx } from "../uiShared.js";

const SLIDING_TAB_ANIMATION_MS = 320;

export function SlidingTabs({
  options,
  value,
  fromValue = null,
  onChange,
  getValue,
  getLabel,
  isOptionDisabled,
  ariaLabel,
  disabled = false,
  className,
}) {
  const barRef = useRef(null);
  const pillRef = useRef(null);
  const measuredRef = useRef(false);
  const fromValueRef = useRef(fromValue);
  const previousValueRef = useRef(value);
  const moveToActiveRef = useRef(null);
  const barWidthRef = useRef(null);
  const animatingRef = useRef(false);
  const animationTimeoutRef = useRef(null);

  useEffect(() => {
    fromValueRef.current = fromValue;
  }, [fromValue]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return undefined;

    function tabForValue(tabValue) {
      if (!tabValue) return null;
      return [...bar.querySelectorAll(".t-tab")].find(
        (tab) => tab.dataset.value === tabValue,
      );
    }

    function moveToTab(tab, animate) {
      if (!tab) return;

      const tabLeft = tab.offsetLeft;
      const tabWidth = tab.offsetWidth;

      window.clearTimeout(animationTimeoutRef.current);

      if (!animate) {
        animatingRef.current = false;
        const previousTransition = pill.style.transition;
        pill.style.transition = "none";
        pill.style.transform = `translateX(${tabLeft}px)`;
        pill.style.width = `${tabWidth}px`;
        void pill.offsetWidth;
        pill.style.transition = previousTransition;
        return;
      }

      animatingRef.current = true;
      animationTimeoutRef.current = window.setTimeout(() => {
        animatingRef.current = false;
      }, SLIDING_TAB_ANIMATION_MS);

      pill.style.transform = `translateX(${tabLeft}px)`;
      pill.style.width = `${tabWidth}px`;
    }

    function moveToActive(animate) {
      const activeTab =
        tabForValue(value) ||
        bar.querySelector('[aria-selected="true"]') ||
        bar.querySelector(".t-tab");

      moveToTab(activeTab, animate);
    }

    moveToActiveRef.current = moveToActive;

    const previousValue = measuredRef.current
      ? previousValueRef.current
      : fromValueRef.current;
    const previousTab = tabForValue(previousValue);
    const shouldAnimate = Boolean(previousTab && previousValue !== value);

    if (shouldAnimate) {
      moveToTab(previousTab, false);
    } else {
      moveToActive(false);
    }

    barWidthRef.current = bar.offsetWidth;
    measuredRef.current = true;
    previousValueRef.current = value;
    fromValueRef.current = null;

    const frameId = shouldAnimate
      ? requestAnimationFrame(() => moveToActive(true))
      : null;

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [options, value]);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;

    const pill = pillRef.current;

    function handleResize() {
      const barWidth = bar.offsetWidth;
      if (barWidth === barWidthRef.current) return;

      barWidthRef.current = barWidth;
      moveToActiveRef.current?.(animatingRef.current);
    }

    function handleTransitionEnd(event) {
      if (event.target !== pill) return;
      window.clearTimeout(animationTimeoutRef.current);
      animatingRef.current = false;
    }

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(handleResize);

    resizeObserver?.observe(bar);
    pill?.addEventListener("transitionend", handleTransitionEnd);
    window.addEventListener("resize", handleResize);
    return () => {
      resizeObserver?.disconnect();
      pill?.removeEventListener("transitionend", handleTransitionEnd);
      window.removeEventListener("resize", handleResize);
      window.clearTimeout(animationTimeoutRef.current);
    };
  }, []);

  return (
    <div
      ref={barRef}
      className={cx("t-tabs", disabled && "is-disabled", className)}
      role="tablist"
      aria-label={ariaLabel}
    >
      <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
      {options.map((option) => {
        const optionValue = getValue(option);
        const selected = optionValue === value;
        const optionDisabled = disabled || isOptionDisabled?.(option);
        return (
          <button
            key={optionValue}
            type="button"
            role="tab"
            aria-selected={selected}
            data-value={optionValue}
            disabled={optionDisabled}
            onClick={() => onChange(optionValue)}
            className={cx(
              "t-tab min-w-0 flex-1 whitespace-nowrap",
              optionDisabled && "is-option-disabled",
            )}
          >
            {getLabel(option)}
          </button>
        );
      })}
    </div>
  );
}
