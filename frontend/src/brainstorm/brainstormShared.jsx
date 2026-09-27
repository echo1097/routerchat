import { useEffect, useRef, useState } from "react";
import { cx } from "../uiShared.js";

export function brainstormDurationLabel(node) {
  let durationMs = Number(node.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    const createdAt = Date.parse(node.created_at || "");
    const updatedAt = Date.parse(node.updated_at || "");
    durationMs = Number.isFinite(createdAt) && Number.isFinite(updatedAt)
      ? updatedAt - createdAt
      : 0;
  }

  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}


export function useCopyAction(getText) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef(null);

  useEffect(() => () => window.clearTimeout(resetRef.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(getText());
    } catch {
      return;
    }
    setCopied(true);
    window.clearTimeout(resetRef.current);
    resetRef.current = window.setTimeout(() => setCopied(false), 1600);
  }

  return [copied, copy];
}


export function NodeText({ className, children }) {
  const scrollRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);

  function updateEdges(element) {
    const bottomOffset = element.scrollHeight - element.clientHeight - element.scrollTop;
    setScrolled(element.scrollTop > 2);
    setHasMoreBelow(bottomOffset > 2);
  }

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const frame = requestAnimationFrame(() => updateEdges(node));
    return () => cancelAnimationFrame(frame);
  }, [children]);

  return (
    <div className="brainstorm-scroll">
      <p
        ref={scrollRef}
        className={className}
        onScroll={(event) => updateEdges(event.currentTarget)}
      >
        {children}
      </p>
      <div
        aria-hidden="true"
        className={cx("brainstorm-scroll-fade is-top", scrolled && "is-visible")}
      />
      <div
        aria-hidden="true"
        className={cx("brainstorm-scroll-fade is-bottom", hasMoreBelow && "is-visible")}
      />
    </div>
  );
}


export function brainstormEdgePath(sourceX, sourceY, targetX, targetY) {
  const reach = Math.max(targetX - sourceX, 24) * 0.5;
  return `M ${sourceX},${sourceY} C ${sourceX + reach},${sourceY} ${targetX - reach},${targetY} ${targetX},${targetY}`;
}
