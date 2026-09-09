import { useId } from "react";
import { cx, CONTROL_MOTION } from "../uiShared.js";

export function ContextWindowMeter({ info, placement = "above" }) {
  const tooltipId = useId();
  if (!info) return null;

  const percent = Math.min(Math.max(info.percentFull, 0), 100);
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - percent / 100);
  const ariaLabel = `Context window ${info.displayPercent}, ${info.displayUsage}`;

  return (
    <span
      className={cx(
        "t-tt-wrap context-meter-wrap inline-flex h-8 w-8 shrink-0 items-center justify-center",
        placement === "belowEnd" && "context-meter-wrap-below-end",
      )}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-describedby={tooltipId}
        className={cx(
          "t-tt-trigger grid h-8 w-8 place-items-center rounded-full text-neutral-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
          CONTROL_MOTION,
          "hover:text-neutral-100",
        )}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="h-[11px] w-[11px] -rotate-90"
        >
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="opacity-35"
          />
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="opacity-80 transition-[stroke-dashoffset] duration-300 ease-out"
          />
        </svg>
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="t-tt context-meter-tooltip"
      >
        <span className="block text-neutral-100">
          {info.displayUsage}
        </span>
      </span>
    </span>
  );
}
