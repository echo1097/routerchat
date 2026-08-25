import { useEffect, useRef, useState } from "react";

import { cx } from "./uiShared.js";

function readMs(name, fallback) {
  const value = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );

  return Number.isFinite(value) ? value : fallback;
}

export function useThinkingSwap(text) {
  const [lines, setLines] = useState(() => [{ id: 0, text, phase: "live" }]);
  const shownRef = useRef(text);
  const idRef = useRef(0);
  const timersRef = useRef([]);

  const clearTimers = () => {
    timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    timersRef.current = [];
  };

  useEffect(() => () => clearTimers(), []);

  useEffect(() => {
    if (text === shownRef.current) return;

    shownRef.current = text;
    idRef.current += 1;
    const id = idRef.current;

    const swap = readMs("--think-swap", 150);
    const gap = readMs("--think-gap", 50);

    clearTimers();

    setLines((current) => [
      ...current
        .filter((line) => line.phase !== "exit")
        .map((line) => ({ ...line, phase: "exit" })),
      { id, text, phase: "enter" },
    ]);

    const releaseId = window.setTimeout(() => {
      setLines((current) => current.map((line) => (
        line.id === id ? { ...line, phase: "live" } : line
      )));
    }, gap);

    const settleId = window.setTimeout(() => {
      setLines((current) => current.filter((line) => line.phase !== "exit"));
    }, swap + gap);

    timersRef.current = [releaseId, settleId];
  }, [text]);

  return lines;
}

export function ThinkingStatus({ label, states, shimmering = true, align = "left", className }) {
  const lines = useThinkingSwap(label);
  const sizerStates = states?.length ? states : [label];

  return (
    <span className={cx("t-think", align === "right" && "is-right", className)}>
      <span className="t-think-sizer" aria-hidden="true">
        {sizerStates.map((state) => (
          <span key={state}>{state}</span>
        ))}
      </span>
      {lines.map((line) => (
        <span
          key={line.id}
          className={cx(
            "t-think-text",
            shimmering && "t-shimmer",
            line.phase === "exit" && "is-exit",
            line.phase === "enter" && "is-enter-start",
          )}
          data-text={line.text}
        >
          {line.text}
        </span>
      ))}
    </span>
  );
}
