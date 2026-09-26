import { useId } from "react";
import { cx, CONTROL_MOTION } from "../uiShared.js";

const warningLevels = [
  { minPercent: 90, note: "Almost full", fillClass: "stroke-[#fca5a5] opacity-100", trackClass: "stroke-[#fca5a5]", noteClass: "text-[#fca5a5]" },
  { minPercent: 75, note: "Getting full", fillClass: "stroke-[#fde68a] opacity-100", trackClass: "stroke-[#fde68a]", noteClass: "text-[#fde68a]" },
  { minPercent: 50, note: "Half full", fillClass: "stroke-[#f5f5f5] opacity-100", trackClass: "", noteClass: "text-neutral-400" },
];

function getWarningLevel(percent) {
  return warningLevels.find((level) => percent >= level.minPercent) ?? null;
}

export function ContextWindowMeter({ info, placement = "above" }) {
  const tooltipId = useId();
  if (!info) return null;

  const percent = Math.min(Math.max(info.percentFull, 0), 100);
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - percent / 100);
  const warningLevel = getWarningLevel(percent);
  const ariaLabel = warningLevel
    ? `Context window ${info.displayPercent}, ${info.displayUsage}, ${warningLevel.note.toLowerCase()}`
    : `Context window ${info.displayPercent}, ${info.displayUsage}`;

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
            className={cx("opacity-35 transition-[stroke] duration-300 ease-out", warningLevel?.trackClass)}
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
            className={cx(
              "transition-[stroke-dashoffset,stroke,opacity] duration-300 ease-out",
              warningLevel ? warningLevel.fillClass : "opacity-80",
            )}
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
        {warningLevel && (
          <span className={cx("block text-[11px]", warningLevel.noteClass)}>
            {warningLevel.note}
          </span>
        )}
      </span>
    </span>
  );
}
